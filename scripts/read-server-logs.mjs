import { execSync } from 'child_process';

const lines = process.argv[2] || 50;
try {
    const out = execSync(`ssh abakus 'tail -n ${lines} ~/novajs-server.log'`, { encoding: 'utf8' });
    console.log(out);
} catch (e) {
    console.error('Failed to read server logs from abakus:', e.message);
}
