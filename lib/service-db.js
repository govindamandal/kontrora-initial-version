const { createAdminSupabaseClient } = require('./supabase-server');

function database(client) {
  const db = client || createAdminSupabaseClient();
  if (!db) throw new Error('Database is not configured');
  return db;
}
async function result(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
module.exports = { database, result };
