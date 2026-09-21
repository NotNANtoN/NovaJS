import Jasmine from 'jasmine';
import { pathToFileURL } from 'node:url';

const jasmine = new Jasmine();
jasmine.exitOnCompletion = false;
jasmine.loadConfig({
    random: false,
    stopSpecOnExpectationFailure: false,
    stopOnSpecFailure: false,
});
await import(pathToFileURL(process.argv[2]).href);
const result = await jasmine.execute();
process.exitCode = result.overallStatus === 'passed' ? 0 : 1;
