import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const fixturesDir = path.join(__dirname, '../../test/fixtures');

export function resolveFixture(p: string) {
  return path.join(fixturesDir, p);
}
