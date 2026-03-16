const { Pool } = require('pg');

let config;

if (process.env.NODE_ENV === 'production') {
  // Для продакшена (Render.com)
  config = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  };
} else {
  // Для локальной разработки
  config = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'CinemaBox',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Mm0298293386'
  };
}

const pool = new Pool(config);

module.exports = pool;