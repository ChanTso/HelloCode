#!/usr/bin/env node

const args = new Set(process.argv.slice(2));

if (args.has('--version') || args.has('-v')) {
  console.log('HelloCode 0.1.0');
} else {
  console.log('HelloCode is ready. Run with --help for usage.');
}
