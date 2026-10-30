// Runs one revision's scripts/draw.ts for validate.ts in a separate process: rows and beacons on stdin, the draw as JSON on stdout.
// Whatever that draw.ts does when imported, it does here, not inside the process that decides pass or fail (clawdsmith, 10-30).
const m = await import(process.argv[2]);
if (typeof m.draw !== "function") { console.error("exports no draw()"); process.exit(2); }
const { runs, beacons } = JSON.parse(await Bun.stdin.text());
const d = m.draw(runs, beacons);
process.stdout.write(JSON.stringify({ pool: d.pool, rows: d.rows.map(({ excluded, ...x }: any) => x) }));
