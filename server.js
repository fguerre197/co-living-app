'use strict';

/**
 * Co-Living Room Finder — server
 *
 * Storage:
 *  - If DATABASE_URL is set (e.g. on Railway), data lives in PostgreSQL.
 *  - Otherwise data lives in a local JSON file (data.json) so the app
 *    still runs with zero setup. API behavior is identical in both modes.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_PG = DATABASE_URL.length > 0;

/* ------------------------------------------------------------------ */
/* Storage layer                                                       */
/* ------------------------------------------------------------------ */

const LISTING_FIELDS = [
  'owner_name', 'owner_email', 'title', 'city', 'neighborhood', 'rent',
  'deposit', 'room_type', 'bathroom', 'furnished', 'utilities_included',
  'available_date', 'min_stay_months', 'housemates', 'description',
  'amenities', 'house_rules', 'photo_url', 'status'
];

const APPLICATION_FIELDS = [
  'applicant_name', 'email', 'phone', 'move_in_date', 'planned_stay', 'message'
];

const LISTING_STATUSES = ['active', 'paused', 'filled'];
const APPLICATION_STATUSES = ['new', 'reviewing', 'accepted', 'declined'];

function normalizeListingInput(body) {
  const num = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const int = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
  return {
    owner_name: String(body.owner_name || '').trim(),
    owner_email: String(body.owner_email || '').trim().toLowerCase(),
    title: String(body.title || '').trim(),
    city: String(body.city || '').trim(),
    neighborhood: String(body.neighborhood || '').trim(),
    rent: num(body.rent, 0),
    deposit: num(body.deposit, 0),
    room_type: body.room_type === 'shared' ? 'shared' : 'private',
    bathroom: body.bathroom === 'shared' ? 'shared' : 'private',
    furnished: bool(body.furnished),
    utilities_included: bool(body.utilities_included),
    available_date: String(body.available_date || '').trim(),
    min_stay_months: int(body.min_stay_months, 1),
    housemates: int(body.housemates, 0),
    description: String(body.description || '').trim(),
    amenities: Array.isArray(body.amenities) ? body.amenities.map(String) : [],
    house_rules: String(body.house_rules || '').trim(),
    photo_url: String(body.photo_url || '').trim(),
    status: LISTING_STATUSES.includes(body.status) ? body.status : 'active'
  };
}

function normalizeApplicationInput(body) {
  return {
    applicant_name: String(body.applicant_name || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    phone: String(body.phone || '').trim(),
    move_in_date: String(body.move_in_date || '').trim(),
    planned_stay: String(body.planned_stay || '').trim(),
    message: String(body.message || '').trim()
  };
}

/* ---------------- PostgreSQL backend ---------------- */

let pool = null;

async function pgInit() {
  const { Pool } = require('pg');
  const looksLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: looksLocal ? false : { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      owner_name TEXT NOT NULL DEFAULT '',
      owner_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      neighborhood TEXT NOT NULL DEFAULT '',
      rent NUMERIC NOT NULL DEFAULT 0,
      deposit NUMERIC NOT NULL DEFAULT 0,
      room_type TEXT NOT NULL DEFAULT 'private',
      bathroom TEXT NOT NULL DEFAULT 'private',
      furnished BOOLEAN NOT NULL DEFAULT false,
      utilities_included BOOLEAN NOT NULL DEFAULT false,
      available_date TEXT NOT NULL DEFAULT '',
      min_stay_months INTEGER NOT NULL DEFAULT 1,
      housemates INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      amenities JSONB NOT NULL DEFAULT '[]'::jsonb,
      house_rules TEXT NOT NULL DEFAULT '',
      photo_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      applicant_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      move_in_date TEXT NOT NULL DEFAULT '',
      planned_stay TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function pgRowToListing(r) {
  return {
    id: r.id,
    owner_name: r.owner_name,
    owner_email: r.owner_email,
    title: r.title,
    city: r.city,
    neighborhood: r.neighborhood,
    rent: parseFloat(r.rent),
    deposit: parseFloat(r.deposit),
    room_type: r.room_type,
    bathroom: r.bathroom,
    furnished: !!r.furnished,
    utilities_included: !!r.utilities_included,
    available_date: r.available_date,
    min_stay_months: r.min_stay_months,
    housemates: r.housemates,
    description: r.description,
    amenities: Array.isArray(r.amenities) ? r.amenities : [],
    house_rules: r.house_rules,
    photo_url: r.photo_url,
    status: r.status,
    created_at: r.created_at,
    application_count: r.application_count !== undefined ? parseInt(r.application_count, 10) : undefined
  };
}

const pgStore = {
  async listPublic(filters) {
    const clauses = ["status = 'active'"];
    const params = [];
    if (filters.search) {
      params.push('%' + filters.search.toLowerCase() + '%');
      clauses.push(`(lower(title) LIKE $${params.length} OR lower(city) LIKE $${params.length} OR lower(neighborhood) LIKE $${params.length} OR lower(description) LIKE $${params.length})`);
    }
    if (filters.city) {
      params.push(filters.city.toLowerCase());
      clauses.push(`lower(city) = $${params.length}`);
    }
    if (filters.maxRent) {
      params.push(parseFloat(filters.maxRent));
      clauses.push(`rent <= $${params.length}`);
    }
    if (filters.roomType) {
      params.push(filters.roomType);
      clauses.push(`room_type = $${params.length}`);
    }
    if (filters.furnished === 'true') clauses.push('furnished = true');
    const { rows } = await pool.query(
      `SELECT * FROM listings WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
    return rows.map(pgRowToListing);
  },
  async listAll() {
    const { rows } = await pool.query('SELECT * FROM listings ORDER BY created_at DESC');
    return rows.map(pgRowToListing);
  },
  async get(id) {
    const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
    return rows.length ? pgRowToListing(rows[0]) : null;
  },
  async create(data) {
    const cols = LISTING_FIELDS;
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    const values = cols.map((c) => (c === 'amenities' ? JSON.stringify(data[c]) : data[c]));
    const { rows } = await pool.query(
      `INSERT INTO listings (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, values);
    return pgRowToListing(rows[0]);
  },
  async listByOwner(email) {
    const { rows } = await pool.query(
      `SELECT l.*, COUNT(a.id) AS application_count
       FROM listings l LEFT JOIN applications a ON a.listing_id = l.id
       WHERE lower(l.owner_email) = $1
       GROUP BY l.id ORDER BY l.created_at DESC`, [email]);
    return rows.map(pgRowToListing);
  },
  async update(id, data, email) {
    const cols = LISTING_FIELDS.filter((c) => c !== 'owner_email');
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map((c) => (c === 'amenities' ? JSON.stringify(data[c]) : data[c]));
    values.push(id, email);
    const { rows } = await pool.query(
      `UPDATE listings SET ${sets} WHERE id = $${values.length - 1} AND lower(owner_email) = $${values.length} RETURNING *`,
      values);
    return rows.length ? pgRowToListing(rows[0]) : null;
  },
  async setStatus(id, status, email) {
    const { rows } = await pool.query(
      'UPDATE listings SET status = $1 WHERE id = $2 AND lower(owner_email) = $3 RETURNING *',
      [status, id, email]);
    return rows.length ? pgRowToListing(rows[0]) : null;
  },
  async remove(id, email) {
    const { rowCount } = await pool.query(
      'DELETE FROM listings WHERE id = $1 AND lower(owner_email) = $2', [id, email]);
    return rowCount > 0;
  },
  async createApplication(listingId, data) {
    const { rows } = await pool.query(
      `INSERT INTO applications (listing_id, ${APPLICATION_FIELDS.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [listingId, ...APPLICATION_FIELDS.map((c) => data[c])]);
    return rows[0];
  },
  async listApplicationsForOwner(email) {
    const { rows } = await pool.query(
      `SELECT a.*, l.title AS listing_title, l.city AS listing_city
       FROM applications a JOIN listings l ON l.id = a.listing_id
       WHERE lower(l.owner_email) = $1
       ORDER BY a.created_at DESC`, [email]);
    return rows;
  },
  async setApplicationStatus(id, status, email) {
    const { rows } = await pool.query(
      `UPDATE applications a SET status = $1 FROM listings l
       WHERE a.id = $2 AND a.listing_id = l.id AND lower(l.owner_email) = $3
       RETURNING a.*`,
      [status, id, email]);
    return rows.length ? rows[0] : null;
  }
};

/* ---------------- JSON file backend ---------------- */

const DATA_FILE = path.join(__dirname, 'data.json');

function jsonLoad() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed.listings) && Array.isArray(parsed.applications)) return parsed;
  } catch (_) { /* missing or unreadable file: start fresh */ }
  return { listings: [], applications: [], nextListingId: 1, nextApplicationId: 1 };
}

function jsonSave(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const jsonStore = {
  async listPublic(filters) {
    const db = jsonLoad();
    return db.listings.filter((l) => {
      if (l.status !== 'active') return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = [l.title, l.city, l.neighborhood, l.description].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.city && l.city.toLowerCase() !== filters.city.toLowerCase()) return false;
      if (filters.maxRent && !(l.rent <= parseFloat(filters.maxRent))) return false;
      if (filters.roomType && l.room_type !== filters.roomType) return false;
      if (filters.furnished === 'true' && !l.furnished) return false;
      return true;
    }).sort((a, b) => b.id - a.id);
  },
  async listAll() {
    const db = jsonLoad();
    return [...db.listings].sort((a, b) => b.id - a.id);
  },
  async get(id) {
    const db = jsonLoad();
    return db.listings.find((l) => l.id === Number(id)) || null;
  },
  async create(data) {
    const db = jsonLoad();
    const listing = { id: db.nextListingId++, ...data, created_at: new Date().toISOString() };
    db.listings.push(listing);
    jsonSave(db);
    return listing;
  },
  async listByOwner(email) {
    const db = jsonLoad();
    return db.listings
      .filter((l) => l.owner_email === email)
      .map((l) => ({
        ...l,
        application_count: db.applications.filter((a) => a.listing_id === l.id).length
      }))
      .sort((a, b) => b.id - a.id);
  },
  async update(id, data, email) {
    const db = jsonLoad();
    const idx = db.listings.findIndex((l) => l.id === Number(id) && l.owner_email === email);
    if (idx === -1) return null;
    const { owner_email, ...rest } = data;
    db.listings[idx] = { ...db.listings[idx], ...rest };
    jsonSave(db);
    return db.listings[idx];
  },
  async setStatus(id, status, email) {
    const db = jsonLoad();
    const listing = db.listings.find((l) => l.id === Number(id) && l.owner_email === email);
    if (!listing) return null;
    listing.status = status;
    jsonSave(db);
    return listing;
  },
  async remove(id, email) {
    const db = jsonLoad();
    const before = db.listings.length;
    db.listings = db.listings.filter((l) => !(l.id === Number(id) && l.owner_email === email));
    if (db.listings.length === before) return false;
    db.applications = db.applications.filter((a) => a.listing_id !== Number(id));
    jsonSave(db);
    return true;
  },
  async createApplication(listingId, data) {
    const db = jsonLoad();
    const application = {
      id: db.nextApplicationId++,
      listing_id: Number(listingId),
      ...data,
      status: 'new',
      created_at: new Date().toISOString()
    };
    db.applications.push(application);
    jsonSave(db);
    return application;
  },
  async listApplicationsForOwner(email) {
    const db = jsonLoad();
    const mine = new Map(db.listings.filter((l) => l.owner_email === email).map((l) => [l.id, l]));
    return db.applications
      .filter((a) => mine.has(a.listing_id))
      .map((a) => ({
        ...a,
        listing_title: mine.get(a.listing_id).title,
        listing_city: mine.get(a.listing_id).city
      }))
      .sort((a, b) => b.id - a.id);
  },
  async setApplicationStatus(id, status, email) {
    const db = jsonLoad();
    const application = db.applications.find((a) => a.id === Number(id));
    if (!application) return null;
    const listing = db.listings.find((l) => l.id === application.listing_id);
    if (!listing || listing.owner_email !== email) return null;
    application.status = status;
    jsonSave(db);
    return application;
  }
};

const store = USE_PG ? pgStore : jsonStore;

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

// Public: browse active listings with filters
app.get('/api/listings', async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      city: req.query.city || '',
      maxRent: req.query.maxRent || '',
      roomType: req.query.roomType || '',
      furnished: req.query.furnished || ''
    };
    res.json(await store.listPublic(filters));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load listings' });
  }
});

// Public: one listing's details
app.get('/api/listings/:id', async (req, res) => {
  try {
    const listing = await store.get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json(listing);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load listing' });
  }
});

// Owner: create a listing
app.post('/api/listings', async (req, res) => {
  try {
    const data = normalizeListingInput(req.body || {});
    if (!data.owner_name || !data.owner_email) {
      return res.status(400).json({ error: 'Owner name and email are required' });
    }
    if (!data.title || !data.city) {
      return res.status(400).json({ error: 'Title and city are required' });
    }
    res.status(201).json(await store.create(data));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

// Owner: my listings (with application counts)
app.get('/api/my-listings', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query parameter is required' });
    res.json(await store.listByOwner(email));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load your listings' });
  }
});

// Owner: edit a listing
app.put('/api/listings/:id', async (req, res) => {
  try {
    const data = normalizeListingInput(req.body || {});
    if (!data.owner_email) return res.status(400).json({ error: 'owner_email is required' });
    const updated = await store.update(req.params.id, data, data.owner_email);
    if (!updated) return res.status(404).json({ error: 'Listing not found for this owner' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// Owner: pause / reactivate / mark filled
app.post('/api/listings/:id/status', async (req, res) => {
  try {
    const email = String((req.body || {}).owner_email || '').trim().toLowerCase();
    const status = (req.body || {}).status;
    if (!email) return res.status(400).json({ error: 'owner_email is required' });
    if (!LISTING_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const updated = await store.setStatus(req.params.id, status, email);
    if (!updated) return res.status(404).json({ error: 'Listing not found for this owner' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Owner: delete a listing (and its applications)
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query parameter is required' });
    const removed = await store.remove(req.params.id, email);
    if (!removed) return res.status(404).json({ error: 'Listing not found for this owner' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

// Renter: apply for a room
app.post('/api/listings/:id/applications', async (req, res) => {
  try {
    const listing = await store.get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const data = normalizeApplicationInput(req.body || {});
    if (!data.applicant_name || !data.email) {
      return res.status(400).json({ error: 'Your name and email are required' });
    }
    const application = await store.createApplication(listing.id, data);
    res.status(201).json(application);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// Owner: applications inbox
app.get('/api/applications', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query parameter is required' });
    res.json(await store.listApplicationsForOwner(email));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

// Owner: set an application's status
app.post('/api/applications/:id/status', async (req, res) => {
  try {
    const email = String((req.body || {}).owner_email || '').trim().toLowerCase();
    const status = (req.body || {}).status;
    if (!email) return res.status(400).json({ error: 'owner_email is required' });
    if (!APPLICATION_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const updated = await store.setApplicationStatus(req.params.id, status, email);
    if (!updated) return res.status(404).json({ error: 'Application not found for this owner' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

/* ---------------- RentCast import ---------------- */

// Map one RentCast long-term rental listing into this app's listing shape.
// The result is passed through normalizeListingInput and store.create, so
// imports live in the same storage (PostgreSQL or JSON file) as manual listings.
function rentcastToListing(r) {
  const city = String(r.city || '').trim();
  let title = String(r.formattedAddress || '').trim();
  if (!title) {
    const line1 = String(r.addressLine1 || '').trim();
    if (line1) title = city ? line1 + ', ' + city : line1;
  }
  if (!title) title = 'Rental in ' + (city || 'this area');
  const facts = [];
  if (r.bedrooms != null && r.bedrooms !== '') facts.push(r.bedrooms + ' bed');
  if (r.bathrooms != null && r.bathrooms !== '') facts.push(r.bathrooms + ' bath');
  if (r.squareFootage) facts.push(Number(r.squareFootage).toLocaleString() + ' sq ft');
  if (r.propertyType) facts.push(String(r.propertyType));
  const note = 'Imported from RentCast — reference listing; contact the listing office for availability.';
  const listed = typeof r.listedDate === 'string' ? r.listedDate.slice(0, 10) : '';
  return {
    owner_name: (r.listingOffice && r.listingOffice.name) || 'RentCast import',
    owner_email: 'imports@rentcast.local',
    title,
    city,
    neighborhood: '',
    rent: r.listPrice != null ? r.listPrice : (r.price != null ? r.price : 0),
    deposit: 0,
    room_type: 'private',
    bathroom: 'private',
    furnished: false,
    utilities_included: false,
    available_date: /^\d{4}-\d{2}-\d{2}$/.test(listed) ? listed : '',
    min_stay_months: 1,
    housemates: 0,
    description: (facts.length ? facts.join(' · ') + '. ' : '') + note,
    amenities: [],
    house_rules: '',
    photo_url: '',
    status: 'active'
  };
}

// Import: pull active rental listings from RentCast for a city/state/ZIP
app.post('/api/import/rentals', async (req, res) => {
  try {
    const apiKey = process.env.RENTCAST_API_KEY || '';
    if (!apiKey) {
      return res.status(503).json({ error: "Import isn't configured yet — add RENTCAST_API_KEY to the Railway variables." });
    }
    const body = req.body || {};
    const city = String(body.city || '').trim();
    const state = String(body.state || '').trim();
    const zipCode = String(body.zipCode || '').trim();
    if (!city && !state && !zipCode) {
      return res.status(400).json({ error: 'Enter a city, state, or ZIP code to import rentals for.' });
    }
    let limit = parseInt(body.limit, 10);
    if (!Number.isFinite(limit)) limit = 20;
    limit = Math.min(50, Math.max(1, limit));

    const params = new URLSearchParams({ status: 'Active', limit: String(limit) });
    if (city) params.set('city', city);
    if (state) params.set('state', state);
    if (zipCode) params.set('zipCode', zipCode);

    let upstream;
    try {
      upstream = await fetch('https://api.rentcast.io/v1/listings/rental/long-term?' + params.toString(), {
        headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
    } catch (netErr) {
      if (netErr && (netErr.name === 'TimeoutError' || netErr.name === 'AbortError')) {
        return res.status(504).json({ error: 'RentCast took too long to respond — please try again in a moment.' });
      }
      console.error(netErr);
      return res.status(502).json({ error: 'Could not reach RentCast right now — please try again later.' });
    }

    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) {
        return res.status(502).json({ error: 'RentCast rejected the API key — check that RENTCAST_API_KEY is correct in the Railway variables.' });
      }
      if (upstream.status === 429) {
        return res.status(502).json({ error: 'RentCast rate limit hit — the free monthly quota may be used up. Try again later or upgrade your RentCast plan.' });
      }
      return res.status(502).json({ error: 'RentCast returned an error (HTTP ' + upstream.status + ') — please try again later.' });
    }

    const payload = await upstream.json().catch(() => null);
    const results = Array.isArray(payload) ? payload : [];

    const dedupeKey = (l) => [
      String(l.title || '').trim().toLowerCase(),
      String(l.city || '').trim().toLowerCase(),
      Number(l.rent) || 0
    ].join('|');
    const existing = new Set((await store.listAll()).map(dedupeKey));
    let imported = 0;
    let skipped = 0;
    for (const raw of results) {
      const data = normalizeListingInput(rentcastToListing(raw || {}));
      const key = dedupeKey(data);
      if (existing.has(key)) { skipped++; continue; }
      await store.create(data);
      existing.add(key);
      imported++;
    }
    res.json({ imported, skipped, total: results.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import rentals' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, storage: USE_PG ? 'postgres' : 'json-file' });
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  if (USE_PG) {
    await pgInit();
    console.log('Storage: PostgreSQL (DATABASE_URL set)');
  } else {
    console.log('Storage: local JSON file (data.json) — set DATABASE_URL to use PostgreSQL');
  }
  app.listen(PORT, () => console.log(`Co-Living Room Finder running on port ${PORT}`));
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
