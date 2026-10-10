// Loaded by mocha before anything else (package.json: -r ./test/env.cjs), so
// that the server's configuration is read as a test's: none of a developer's
// own .env.development reaches the tests, and the log is quiet.
process.env.NODE_ENV = 'test';
for (const name of ['JWT_SECRET', 'PLAYER_KEY_SECRET', 'STEAM_APP_ID', 'STEAM_WEB_API_KEY', 'ALLOWED_ORIGINS', 'TRUST_PROXY', 'DEV_AUTH', 'METRICS_TOKEN', 'MONITOR_PASSWORD', 'MIN_GAME_VERSION']) {
    delete process.env[name];
}
