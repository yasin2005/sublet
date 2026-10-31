// Runs every tests/unit/*.test.js and aggregates.
//
// Unit only: no network, no MongoDB connection, no running server. That is the
// point — these must be runnable on a laptop with no credentials and no
// HasData credits, so there is never a reason to skip them.

const fs = require('fs');
const path = require('path');

const UNIT_DIR = path.join(__dirname, 'unit');

const files = fs
  .readdirSync(UNIT_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let totalPassed = 0;
let totalFailed = 0;
const failures = [];

console.log('');

for (const file of files) {
  const full = path.join(UNIT_DIR, file);
  let summary;

  try {
    summary = require(full).run();
  } catch (err) {
    // A file that throws on load is a failure, not a crash of the runner.
    totalFailed += 1;
    failures.push(`${file}: threw on load — ${err.message}`);
    console.log(`  ✗ ${file.padEnd(26)} threw on load`);
    continue;
  }

  totalPassed += summary.passed;
  totalFailed += summary.failed;

  const mark = summary.failed === 0 ? '✓' : '✗';
  const score = `${summary.passed}/${summary.passed + summary.failed}`;
  console.log(`  ${mark} ${file.padEnd(26)} ${score.padStart(8)}`);

  if (summary.failed > 0) {
    for (const line of summary.lines.filter((l) => l.startsWith('FAIL'))) {
      failures.push(`${summary.name}: ${line.replace(/^FAIL\s+/, '')}`);
    }
  }
}

const total = totalPassed + totalFailed;
console.log(`\n  ${totalPassed}/${total} assertions passed across ${files.length} files`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}

console.log('');
process.exit(0);
