'use strict';
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), x: process.env.RUNS_EXEC_X || null, secret: process.env.RUNS_EXEC_SECRET || null }));
