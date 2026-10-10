/**
 * How the server is run under PM2 — which is how Colyseus Cloud runs it, and a
 * fine way to run it on a machine of your own (docs/OPERATIONS.md).
 *
 * ONE instance, on purpose. The limits this server keeps — rooms an account is
 * in, sockets an address has open, attempts a minute — are counted in the
 * process (src/registry.ts). Two processes would each count from nothing, and
 * every limit would be twice as loose. One process carries a great many rooms
 * (a room passes messages on; it does not simulate a world). What has to move
 * to Redis before this number goes up is in docs/OPERATIONS.md, *Scaling*.
 */
module.exports = {
    apps: [{
        name: "wonder-world-online",
        script: "build/index.js",
        time: true,
        watch: false,
        instances: 1,
        exec_mode: "fork",              // never "cluster": Colyseus places rooms itself
        wait_ready: true,               // the server says when it is listening (process.send('ready'))
        kill_timeout: 10000,            // SIGTERM, then this long for every room to be told and closed
        max_memory_restart: "512M",
        env: { NODE_ENV: "production" },
    }],
};
