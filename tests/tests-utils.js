import fs from 'fs';
import path from 'path';
import moment from 'moment';
import json2csv from 'json2csv';

let testsConfig = null;
let configurationLoaded = false;

const MISSING_ERROR_MESSAGE = 'Missing environment test configuration. To troubleshot this issue open CONTRIBUTING.md file and read section "F.A.Q regarding the tests".';

export function getTestsConfig() {
  if (configurationLoaded) {
    if (!testsConfig) {
      throw new Error(MISSING_ERROR_MESSAGE);
    }

    return testsConfig;
  }

  configurationLoaded = true;

  try {
    const environmentConfig = process.env.TESTS_CONFIG;
    if (environmentConfig) {
      testsConfig = JSON.parse(environmentConfig);
      return testsConfig;
    }
  } catch (e) {
    throw new Error(`failed to parse environment variable 'TESTS_CONFIG' with error '${e.message}'`);
  }

  try {
    testsConfig = require('./.tests-config').default;
    return process.env;
  } catch (e) {
    throw new Error(MISSING_ERROR_MESSAGE);
  }
}

export function maybeTestCompanyAPI(scraperId, filter) {
  if (!configurationLoaded) {
    getTestsConfig();
  }
  return testsConfig && testsConfig.companyAPI.enabled &&
  testsConfig.credentials[scraperId] &&
  (!filter || filter(testsConfig)) ? test : test.skip;
}

export function extendAsyncTimeout(timeout = 120000) {
  jest.setTimeout(timeout);
}

export function exportTransactions(fileName, accounts) {
  const config = getTestsConfig();

  if (!config.companyAPI.enabled || !config.companyAPI.excelFilesDist || !fs.existsSync(config.companyAPI.excelFilesDist)) {
    return;
  }

  let data = [];

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];

    data = [
      ...data,
      ...account.txns.map((txn) => {
        return Object.assign(
          { account: account.accountNumber },
          txn, {
            date: moment(txn.date).format('DD/MM/YYYY'),
            processedDate: moment(txn.processedDate).format('DD/MM/YYYY'),
          },
        );
      })];
  }

  if (data.length === 0) {
    data = [
      {
        comment: 'no transaction found for requested time frame'
      },
    ];
  }

  const csv = json2csv.parse(data, { withBOM: true });
  const filePath = `${path.join(config.companyAPI.excelFilesDist, fileName)}.csv`;
  fs.writeFileSync(filePath, csv);
}
