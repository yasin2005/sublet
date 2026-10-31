// Minimal assertion harness. No dependency, no global state, no watch mode —
// these tests exist to protect data-integrity rules that each cost real money
// or real data loss to rediscover, so the harness stays small enough that it
// can never itself be the thing that breaks.
//
// Every test file exports run() and returns { name, passed, failed, lines }.
// tests/run.js aggregates them; each file is also runnable on its own.

function createSuite(name) {
  const lines = [];
  let passed = 0;
  let failed = 0;

  function check(label, condition, detail) {
    const ok = Boolean(condition);
    ok ? passed++ : failed++;
    lines.push(
      `${ok ? 'PASS' : 'FAIL'}  ${label}` + (detail !== undefined ? ` -> ${detail}` : '')
    );
  }

  // Convenience for the common "compare and show what we actually got" case.
  function equal(label, actual, expected) {
    check(label, actual === expected, actual === expected ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }

  function result() {
    return { name, passed, failed, lines };
  }

  // Printed only when a file is run directly; the aggregate runner prints its
  // own summary and shows individual lines just for failures.
  function report() {
    console.log(lines.join('\n'));
    console.log(`\n${passed}/${passed + failed} passed`);
    return result();
  }

  return { check, equal, result, report };
}

module.exports = { createSuite };
