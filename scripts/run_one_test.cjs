const Jasmine = require('jasmine');

const jasmine = new Jasmine();
jasmine.exitOnCompletion = false;
jasmine.loadConfig({
    random: false,
    stopSpecOnExpectationFailure: false,
    stopOnSpecFailure: false,
});
require(process.argv[2]);
jasmine.execute().then(result => {
    process.exitCode = result.overallStatus === 'passed' ? 0 : 1;
});
