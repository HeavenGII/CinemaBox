const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'CinemaBox',
  password: 'Mm0298293386',
  port: 5432,
  ssl: false
});

module.exports = pool;
