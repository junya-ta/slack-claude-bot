import { spawn } from 'child_process';

const proc = spawn('claude', [
  '-p', 'hello',
  '--output-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  '--max-turns', '1',
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

console.log('PID:', proc.pid);

proc.stdout?.on('data', (data) => {
  console.log('STDOUT:', data.toString());
});

proc.stderr?.on('data', (data) => {
  console.log('STDERR:', data.toString());
});

proc.on('close', (code) => {
  console.log('Exit code:', code);
});

proc.on('error', (err) => {
  console.log('Error:', err);
});
