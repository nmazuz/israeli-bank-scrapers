"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _lodash = _interopRequireDefault(require("lodash"));
var _moment = _interopRequireDefault(require("moment"));
var _constants = require("../constants");
var _definitions = require("../definitions");
var _dates = _interopRequireDefault(require("../helpers/dates"));
var _debug = require("../helpers/debug");
var _fetch = require("../helpers/fetch");
var _transactions = require("../helpers/transactions");
var _waiting = require("../helpers/waiting");
var _transactions2 = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _errors = require("./errors");
var _browser = require("../helpers/browser");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const RATE_LIMIT = {
  SLEEP_BETWEEN: 1000,
  TRANSACTIONS_BATCH_SIZE: 10
};
const COUNTRY_CODE = '212';
const ID_TYPE = '1';
const INSTALLMENTS_KEYWORD = 'תשלום';
const DATE_FORMAT = 'DD/MM/YYYY';
const debug = (0, _debug.getDebug)('base-isracard-amex');
function getAccountsUrl(servicesUrl, monthMoment) {
  const billingDate = monthMoment.format('YYYY-MM-DD');
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'DashboardMonth');
  url.searchParams.set('actionCode', '0');
  url.searchParams.set('billingDate', billingDate);
  url.searchParams.set('format', 'Json');
  return url.toString();
}
async function fetchAccounts(page, servicesUrl, monthMoment) {
  const dataUrl = getAccountsUrl(servicesUrl, monthMoment);
  debug(`fetching accounts from ${dataUrl}`);
  const dataResult = await (0, _fetch.fetchGetWithinPage)(page, dataUrl);
  if (dataResult && _lodash.default.get(dataResult, 'Header.Status') === '1' && dataResult.DashboardMonthBean) {
    const {
      cardsCharges
    } = dataResult.DashboardMonthBean;
    if (cardsCharges) {
      return cardsCharges.map(cardCharge => {
        return {
          index: parseInt(cardCharge.cardIndex, 10),
          accountNumber: cardCharge.cardNumber,
          processedDate: (0, _moment.default)(cardCharge.billingDate, DATE_FORMAT).toISOString()
        };
      });
    }
  }
  return [];
}
function getTransactionsUrl(servicesUrl, monthMoment) {
  const month = monthMoment.month() + 1;
  const year = monthMoment.year();
  const monthStr = month < 10 ? `0${month}` : month.toString();
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'CardsTransactionsList');
  url.searchParams.set('month', monthStr);
  url.searchParams.set('year', `${year}`);
  url.searchParams.set('requiredDate', 'N');
  return url.toString();
}
function convertCurrency(currencyStr) {
  if (currencyStr === _constants.SHEKEL_CURRENCY_KEYWORD || currencyStr === _constants.ALT_SHEKEL_CURRENCY) {
    return _constants.SHEKEL_CURRENCY;
  }
  return currencyStr;
}
function getInstallmentsInfo(txn) {
  if (!txn.moreInfo || !txn.moreInfo.includes(INSTALLMENTS_KEYWORD)) {
    return undefined;
  }
  const matches = txn.moreInfo.match(/\d+/g);
  if (!matches || matches.length < 2) {
    return undefined;
  }
  return {
    number: parseInt(matches[0], 10),
    total: parseInt(matches[1], 10)
  };
}
function getTransactionType(txn) {
  return getInstallmentsInfo(txn) ? _transactions2.TransactionTypes.Installments : _transactions2.TransactionTypes.Normal;
}
function convertTransactions(txns, processedDate, options) {
  const filteredTxns = txns.filter(txn => txn.dealSumType !== '1' && txn.voucherNumberRatz !== '000000000' && txn.voucherNumberRatzOutbound !== '000000000');
  return filteredTxns.map(txn => {
    const isOutbound = txn.dealSumOutbound;
    const txnDateStr = isOutbound ? txn.fullPurchaseDateOutbound : txn.fullPurchaseDate;
    const txnMoment = (0, _moment.default)(txnDateStr, DATE_FORMAT);
    const currentProcessedDate = txn.fullPaymentDate ? (0, _moment.default)(txn.fullPaymentDate, DATE_FORMAT).toISOString() : processedDate;
    const result = {
      type: getTransactionType(txn),
      identifier: parseInt(isOutbound ? txn.voucherNumberRatzOutbound : txn.voucherNumberRatz, 10),
      date: txnMoment.toISOString(),
      processedDate: currentProcessedDate,
      originalAmount: isOutbound ? -txn.dealSumOutbound : -txn.dealSum,
      originalCurrency: convertCurrency(txn.currentPaymentCurrency ?? txn.currencyId),
      chargedAmount: isOutbound ? -txn.paymentSumOutbound : -txn.paymentSum,
      chargedCurrency: convertCurrency(txn.currencyId),
      description: isOutbound ? txn.fullSupplierNameOutbound : txn.fullSupplierNameHeb,
      memo: txn.moreInfo || '',
      installments: getInstallmentsInfo(txn) || undefined,
      status: _transactions2.TransactionStatuses.Completed
    };
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions.getRawTransaction)(txn);
    }
    return result;
  });
}
async function fetchTransactions(page, options, companyServiceOptions, startMoment, monthMoment) {
  const accounts = await fetchAccounts(page, companyServiceOptions.servicesUrl, monthMoment);
  const dataUrl = getTransactionsUrl(companyServiceOptions.servicesUrl, monthMoment);
  await (0, _waiting.sleep)(RATE_LIMIT.SLEEP_BETWEEN);
  debug(`fetching transactions from ${dataUrl} for month ${monthMoment.format('YYYY-MM')}`);
  const dataResult = await (0, _fetch.fetchGetWithinPage)(page, dataUrl);
  if (dataResult && _lodash.default.get(dataResult, 'Header.Status') === '1' && dataResult.CardsTransactionsListBean) {
    const accountTxns = {};
    accounts.forEach(account => {
      const txnGroups = _lodash.default.get(dataResult, `CardsTransactionsListBean.Index${account.index}.CurrentCardTransactions`);
      if (txnGroups) {
        let allTxns = [];
        txnGroups.forEach(txnGroup => {
          if (txnGroup.txnIsrael) {
            const txns = convertTransactions(txnGroup.txnIsrael, account.processedDate, options);
            allTxns.push(...txns);
          }
          if (txnGroup.txnAbroad) {
            const txns = convertTransactions(txnGroup.txnAbroad, account.processedDate, options);
            allTxns.push(...txns);
          }
        });
        if (!options.combineInstallments) {
          allTxns = (0, _transactions.fixInstallments)(allTxns);
        }
        if (options.outputData?.enableTransactionsFilterByDate ?? true) {
          allTxns = (0, _transactions.filterOldTransactions)(allTxns, startMoment, options.combineInstallments || false);
        }
        accountTxns[account.accountNumber] = {
          accountNumber: account.accountNumber,
          index: account.index,
          txns: allTxns
        };
      }
    });
    return accountTxns;
  }
  return {};
}
async function getExtraScrapTransaction(page, options, month, accountIndex, transaction) {
  const url = new URL(options.servicesUrl);
  url.searchParams.set('reqName', 'PirteyIska_204');
  url.searchParams.set('CardIndex', accountIndex.toString());
  url.searchParams.set('shovarRatz', transaction.identifier.toString());
  url.searchParams.set('moedChiuv', month.format('MMYYYY'));
  debug(`fetching extra scrap for transaction ${transaction.identifier} for month ${month.format('YYYY-MM')}`);
  const data = await (0, _fetch.fetchGetWithinPage)(page, url.toString());
  if (!data) {
    return transaction;
  }
  const rawCategory = _lodash.default.get(data, 'PirteyIska_204Bean.sector') ?? '';
  return {
    ...transaction,
    category: rawCategory.trim(),
    rawTransaction: (0, _transactions.getRawTransaction)(data, transaction)
  };
}
async function getExtraScrapAccount(page, options, accountMap, month) {
  const accounts = [];
  for (const account of Object.values(accountMap)) {
    debug(`get extra scrap for ${account.accountNumber} with ${account.txns.length} transactions`, month.format('YYYY-MM'));
    const txns = [];
    for (const txnsChunk of _lodash.default.chunk(account.txns, RATE_LIMIT.TRANSACTIONS_BATCH_SIZE)) {
      debug(`processing chunk of ${txnsChunk.length} transactions for account ${account.accountNumber}`);
      const updatedTxns = await Promise.all(txnsChunk.map(t => getExtraScrapTransaction(page, options, month, account.index, t)));
      await (0, _waiting.sleep)(RATE_LIMIT.SLEEP_BETWEEN);
      txns.push(...updatedTxns);
    }
    accounts.push({
      ...account,
      txns
    });
  }
  return accounts.reduce((m, x) => ({
    ...m,
    [x.accountNumber]: x
  }), {});
}
async function getAdditionalTransactionInformation(scraperOptions, accountsWithIndex, page, options, allMonths) {
  if (!scraperOptions.additionalTransactionInformation || scraperOptions.optInFeatures?.includes('isracard-amex:skipAdditionalTransactionInformation')) {
    return accountsWithIndex;
  }
  return (0, _waiting.runSerial)(accountsWithIndex.map((a, i) => () => getExtraScrapAccount(page, options, a, allMonths[i])));
}
async function fetchAllTransactions(page, options, companyServiceOptions, startMoment) {
  const futureMonthsToScrape = options.futureMonthsToScrape ?? 1;
  const allMonths = (0, _dates.default)(startMoment, futureMonthsToScrape);
  const results = await (0, _waiting.runSerial)(allMonths.map(monthMoment => () => {
    return fetchTransactions(page, options, companyServiceOptions, startMoment, monthMoment);
  }));
  const finalResult = await getAdditionalTransactionInformation(options, results, page, companyServiceOptions, allMonths);
  const combinedTxns = {};
  finalResult.forEach(result => {
    Object.keys(result).forEach(accountNumber => {
      let txnsForAccount = combinedTxns[accountNumber];
      if (!txnsForAccount) {
        txnsForAccount = [];
        combinedTxns[accountNumber] = txnsForAccount;
      }
      const toBeAddedTxns = result[accountNumber].txns;
      combinedTxns[accountNumber].push(...toBeAddedTxns);
    });
  });
  const accounts = Object.keys(combinedTxns).map(accountNumber => {
    return {
      accountNumber,
      txns: combinedTxns[accountNumber]
    };
  });
  return {
    success: true,
    accounts
  };
}
class IsracardAmexBaseScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  constructor(options, baseUrl, companyCode) {
    super(options);
    this.baseUrl = baseUrl;
    this.companyCode = companyCode;
    this.servicesUrl = `${baseUrl}/services/ProxyRequestHandler.ashx`;
  }
  async login(credentials) {
    await (0, _browser.maskHeadlessUserAgent)(this.page);
    await this.page.setRequestInterception(true);
    this.page.on('request', request => {
      if (request.url().includes('detector-dom.min.js')) {
        debug('force abort for request do download detector-dom.min.js resource');
        void request.abort(undefined, _browser.interceptionPriorities.abort);
      } else {
        void request.continue(undefined, _browser.interceptionPriorities.continue);
      }
    });

    // Navigate to homepage first to establish session
    debug('warming up browser with homepage');
    await this.navigateTo(this.baseUrl, 'domcontentloaded');
    await (0, _waiting.sleep)(1000);
    debug('navigating to login page');
    await this.navigateTo(`${this.baseUrl}/personalarea/Login`);

    // Click on "או כניסה עם סיסמה קבועה" to open the password login form
    debug('clicking on password login link');
    await this.page.waitForSelector('#flip', {
      visible: true,
      timeout: 30000
    });
    await this.page.click('#flip');

    // Wait for the password form to appear after animation
    debug('waiting for password form to appear');
    await this.page.waitForSelector('#otpLoginId_ID', {
      visible: true,
      timeout: 30000
    });
    await (0, _waiting.sleep)(1000);
    this.emitProgress(_definitions.ScraperProgressTypes.LoggingIn);
    const validateUrl = `${this.servicesUrl}?reqName=ValidateIdData`;
    const validateRequest = {
      id: credentials.id,
      cardSuffix: credentials.card6Digits,
      countryCode: COUNTRY_CODE,
      idType: ID_TYPE,
      checkLevel: '1',
      companyCode: this.companyCode
    };
    debug('logging in with validate request');
    const validateResult = await (0, _fetch.fetchPostWithinPage)(this.page, validateUrl, validateRequest);
    if (!validateResult || !validateResult.Header || validateResult.Header.Status !== '1' || !validateResult.ValidateIdDataBean) {
      throw new Error('unknown error during login');
    }
    const validateReturnCode = validateResult.ValidateIdDataBean.returnCode;
    debug(`user validate with return code '${validateReturnCode}'`);
    if (validateReturnCode === '1') {
      const {
        userName
      } = validateResult.ValidateIdDataBean;
      const loginUrl = `${this.servicesUrl}?reqName=performLogonI`;
      const request = {
        KodMishtamesh: userName,
        MisparZihuy: credentials.id,
        Sisma: credentials.password,
        cardSuffix: credentials.card6Digits,
        countryCode: COUNTRY_CODE,
        idType: ID_TYPE
      };
      debug('user login started');
      const loginResult = await (0, _fetch.fetchPostWithinPage)(this.page, loginUrl, request);
      debug(`user login with status '${loginResult?.status}'`, loginResult);
      if (loginResult && loginResult.status === '1') {
        this.emitProgress(_definitions.ScraperProgressTypes.LoginSuccess);
        return {
          success: true
        };
      }
      if (loginResult && loginResult.status === '3') {
        this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.ChangePassword
        };
      }
      this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.InvalidPassword
      };
    }
    if (validateReturnCode === '4') {
      this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.ChangePassword
      };
    }
    this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
    return {
      success: false,
      errorType: _errors.ScraperErrorTypes.InvalidPassword
    };
  }
  async fetchData() {
    const defaultStartMoment = (0, _moment.default)().subtract(1, 'years');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
    return fetchAllTransactions(this.page, this.options, {
      servicesUrl: this.servicesUrl,
      companyCode: this.companyCode
    }, startMoment);
  }
}
var _default = exports.default = IsracardAmexBaseScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9kYXNoIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbW9tZW50IiwiX2NvbnN0YW50cyIsIl9kZWZpbml0aW9ucyIsIl9kYXRlcyIsIl9kZWJ1ZyIsIl9mZXRjaCIsIl90cmFuc2FjdGlvbnMiLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMyIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXJyb3JzIiwiX2Jyb3dzZXIiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJSQVRFX0xJTUlUIiwiU0xFRVBfQkVUV0VFTiIsIlRSQU5TQUNUSU9OU19CQVRDSF9TSVpFIiwiQ09VTlRSWV9DT0RFIiwiSURfVFlQRSIsIklOU1RBTExNRU5UU19LRVlXT1JEIiwiREFURV9GT1JNQVQiLCJkZWJ1ZyIsImdldERlYnVnIiwiZ2V0QWNjb3VudHNVcmwiLCJzZXJ2aWNlc1VybCIsIm1vbnRoTW9tZW50IiwiYmlsbGluZ0RhdGUiLCJmb3JtYXQiLCJ1cmwiLCJVUkwiLCJzZWFyY2hQYXJhbXMiLCJzZXQiLCJ0b1N0cmluZyIsImZldGNoQWNjb3VudHMiLCJwYWdlIiwiZGF0YVVybCIsImRhdGFSZXN1bHQiLCJmZXRjaEdldFdpdGhpblBhZ2UiLCJfIiwiZ2V0IiwiRGFzaGJvYXJkTW9udGhCZWFuIiwiY2FyZHNDaGFyZ2VzIiwibWFwIiwiY2FyZENoYXJnZSIsImluZGV4IiwicGFyc2VJbnQiLCJjYXJkSW5kZXgiLCJhY2NvdW50TnVtYmVyIiwiY2FyZE51bWJlciIsInByb2Nlc3NlZERhdGUiLCJtb21lbnQiLCJ0b0lTT1N0cmluZyIsImdldFRyYW5zYWN0aW9uc1VybCIsIm1vbnRoIiwieWVhciIsIm1vbnRoU3RyIiwiY29udmVydEN1cnJlbmN5IiwiY3VycmVuY3lTdHIiLCJTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCIsIkFMVF9TSEVLRUxfQ1VSUkVOQ1kiLCJTSEVLRUxfQ1VSUkVOQ1kiLCJnZXRJbnN0YWxsbWVudHNJbmZvIiwidHhuIiwibW9yZUluZm8iLCJpbmNsdWRlcyIsInVuZGVmaW5lZCIsIm1hdGNoZXMiLCJtYXRjaCIsImxlbmd0aCIsIm51bWJlciIsInRvdGFsIiwiZ2V0VHJhbnNhY3Rpb25UeXBlIiwiVHJhbnNhY3Rpb25UeXBlcyIsIkluc3RhbGxtZW50cyIsIk5vcm1hbCIsImNvbnZlcnRUcmFuc2FjdGlvbnMiLCJ0eG5zIiwib3B0aW9ucyIsImZpbHRlcmVkVHhucyIsImZpbHRlciIsImRlYWxTdW1UeXBlIiwidm91Y2hlck51bWJlclJhdHoiLCJ2b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIiwiaXNPdXRib3VuZCIsImRlYWxTdW1PdXRib3VuZCIsInR4bkRhdGVTdHIiLCJmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQiLCJmdWxsUHVyY2hhc2VEYXRlIiwidHhuTW9tZW50IiwiY3VycmVudFByb2Nlc3NlZERhdGUiLCJmdWxsUGF5bWVudERhdGUiLCJyZXN1bHQiLCJ0eXBlIiwiaWRlbnRpZmllciIsImRhdGUiLCJvcmlnaW5hbEFtb3VudCIsImRlYWxTdW0iLCJvcmlnaW5hbEN1cnJlbmN5IiwiY3VycmVudFBheW1lbnRDdXJyZW5jeSIsImN1cnJlbmN5SWQiLCJjaGFyZ2VkQW1vdW50IiwicGF5bWVudFN1bU91dGJvdW5kIiwicGF5bWVudFN1bSIsImNoYXJnZWRDdXJyZW5jeSIsImRlc2NyaXB0aW9uIiwiZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIiwiZnVsbFN1cHBsaWVyTmFtZUhlYiIsIm1lbW8iLCJpbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiQ29tcGxldGVkIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsImZldGNoVHJhbnNhY3Rpb25zIiwiY29tcGFueVNlcnZpY2VPcHRpb25zIiwic3RhcnRNb21lbnQiLCJhY2NvdW50cyIsInNsZWVwIiwiQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbiIsImFjY291bnRUeG5zIiwiZm9yRWFjaCIsImFjY291bnQiLCJ0eG5Hcm91cHMiLCJhbGxUeG5zIiwidHhuR3JvdXAiLCJ0eG5Jc3JhZWwiLCJwdXNoIiwidHhuQWJyb2FkIiwiY29tYmluZUluc3RhbGxtZW50cyIsImZpeEluc3RhbGxtZW50cyIsIm91dHB1dERhdGEiLCJlbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUiLCJmaWx0ZXJPbGRUcmFuc2FjdGlvbnMiLCJnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24iLCJhY2NvdW50SW5kZXgiLCJ0cmFuc2FjdGlvbiIsImRhdGEiLCJyYXdDYXRlZ29yeSIsImNhdGVnb3J5IiwidHJpbSIsImdldEV4dHJhU2NyYXBBY2NvdW50IiwiYWNjb3VudE1hcCIsIk9iamVjdCIsInZhbHVlcyIsInR4bnNDaHVuayIsImNodW5rIiwidXBkYXRlZFR4bnMiLCJQcm9taXNlIiwiYWxsIiwidCIsInJlZHVjZSIsIm0iLCJ4IiwiZ2V0QWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJzY3JhcGVyT3B0aW9ucyIsImFjY291bnRzV2l0aEluZGV4IiwiYWxsTW9udGhzIiwiYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJvcHRJbkZlYXR1cmVzIiwicnVuU2VyaWFsIiwiYSIsImkiLCJmZXRjaEFsbFRyYW5zYWN0aW9ucyIsImZ1dHVyZU1vbnRoc1RvU2NyYXBlIiwiZ2V0QWxsTW9udGhNb21lbnRzIiwicmVzdWx0cyIsImZpbmFsUmVzdWx0IiwiY29tYmluZWRUeG5zIiwia2V5cyIsInR4bnNGb3JBY2NvdW50IiwidG9CZUFkZGVkVHhucyIsInN1Y2Nlc3MiLCJJc3JhY2FyZEFtZXhCYXNlU2NyYXBlciIsIkJhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJjb25zdHJ1Y3RvciIsImJhc2VVcmwiLCJjb21wYW55Q29kZSIsImxvZ2luIiwiY3JlZGVudGlhbHMiLCJtYXNrSGVhZGxlc3NVc2VyQWdlbnQiLCJzZXRSZXF1ZXN0SW50ZXJjZXB0aW9uIiwib24iLCJyZXF1ZXN0IiwiYWJvcnQiLCJpbnRlcmNlcHRpb25Qcmlvcml0aWVzIiwiY29udGludWUiLCJuYXZpZ2F0ZVRvIiwid2FpdEZvclNlbGVjdG9yIiwidmlzaWJsZSIsInRpbWVvdXQiLCJjbGljayIsImVtaXRQcm9ncmVzcyIsIlNjcmFwZXJQcm9ncmVzc1R5cGVzIiwiTG9nZ2luZ0luIiwidmFsaWRhdGVVcmwiLCJ2YWxpZGF0ZVJlcXVlc3QiLCJpZCIsImNhcmRTdWZmaXgiLCJjYXJkNkRpZ2l0cyIsImNvdW50cnlDb2RlIiwiaWRUeXBlIiwiY2hlY2tMZXZlbCIsInZhbGlkYXRlUmVzdWx0IiwiZmV0Y2hQb3N0V2l0aGluUGFnZSIsIkhlYWRlciIsIlN0YXR1cyIsIlZhbGlkYXRlSWREYXRhQmVhbiIsIkVycm9yIiwidmFsaWRhdGVSZXR1cm5Db2RlIiwicmV0dXJuQ29kZSIsInVzZXJOYW1lIiwibG9naW5VcmwiLCJLb2RNaXNodGFtZXNoIiwiTWlzcGFyWmlodXkiLCJTaXNtYSIsInBhc3N3b3JkIiwibG9naW5SZXN1bHQiLCJMb2dpblN1Y2Nlc3MiLCJDaGFuZ2VQYXNzd29yZCIsImVycm9yVHlwZSIsIlNjcmFwZXJFcnJvclR5cGVzIiwiTG9naW5GYWlsZWQiLCJJbnZhbGlkUGFzc3dvcmQiLCJmZXRjaERhdGEiLCJkZWZhdWx0U3RhcnRNb21lbnQiLCJzdWJ0cmFjdCIsInN0YXJ0RGF0ZSIsInRvRGF0ZSIsIm1heCIsIl9kZWZhdWx0IiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9zY3JhcGVycy9iYXNlLWlzcmFjYXJkLWFtZXgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBtb21lbnQsIHsgdHlwZSBNb21lbnQgfSBmcm9tICdtb21lbnQnO1xuaW1wb3J0IHsgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcbmltcG9ydCB7IEFMVF9TSEVLRUxfQ1VSUkVOQ1ksIFNIRUtFTF9DVVJSRU5DWSwgU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfSBmcm9tICcuLi9jb25zdGFudHMnO1xuaW1wb3J0IHsgU2NyYXBlclByb2dyZXNzVHlwZXMgfSBmcm9tICcuLi9kZWZpbml0aW9ucyc7XG5pbXBvcnQgZ2V0QWxsTW9udGhNb21lbnRzIGZyb20gJy4uL2hlbHBlcnMvZGF0ZXMnO1xuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcbmltcG9ydCB7IGZldGNoR2V0V2l0aGluUGFnZSwgZmV0Y2hQb3N0V2l0aGluUGFnZSB9IGZyb20gJy4uL2hlbHBlcnMvZmV0Y2gnO1xuaW1wb3J0IHsgZmlsdGVyT2xkVHJhbnNhY3Rpb25zLCBmaXhJbnN0YWxsbWVudHMsIGdldFJhd1RyYW5zYWN0aW9uIH0gZnJvbSAnLi4vaGVscGVycy90cmFuc2FjdGlvbnMnO1xuaW1wb3J0IHsgcnVuU2VyaWFsLCBzbGVlcCB9IGZyb20gJy4uL2hlbHBlcnMvd2FpdGluZyc7XG5pbXBvcnQge1xuICBUcmFuc2FjdGlvblN0YXR1c2VzLFxuICBUcmFuc2FjdGlvblR5cGVzLFxuICB0eXBlIFRyYW5zYWN0aW9uLFxuICB0eXBlIFRyYW5zYWN0aW9uSW5zdGFsbG1lbnRzLFxuICB0eXBlIFRyYW5zYWN0aW9uc0FjY291bnQsXG59IGZyb20gJy4uL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyIH0gZnJvbSAnLi9iYXNlLXNjcmFwZXItd2l0aC1icm93c2VyJztcbmltcG9ydCB7IFNjcmFwZXJFcnJvclR5cGVzIH0gZnJvbSAnLi9lcnJvcnMnO1xuaW1wb3J0IHsgdHlwZSBTY3JhcGVyT3B0aW9ucywgdHlwZSBTY3JhcGVyU2NyYXBpbmdSZXN1bHQgfSBmcm9tICcuL2ludGVyZmFjZSc7XG5pbXBvcnQgeyBpbnRlcmNlcHRpb25Qcmlvcml0aWVzLCBtYXNrSGVhZGxlc3NVc2VyQWdlbnQgfSBmcm9tICcuLi9oZWxwZXJzL2Jyb3dzZXInO1xuXG5jb25zdCBSQVRFX0xJTUlUID0ge1xuICBTTEVFUF9CRVRXRUVOOiAxMDAwLFxuICBUUkFOU0FDVElPTlNfQkFUQ0hfU0laRTogMTAsXG59IGFzIGNvbnN0O1xuXG5jb25zdCBDT1VOVFJZX0NPREUgPSAnMjEyJztcbmNvbnN0IElEX1RZUEUgPSAnMSc7XG5jb25zdCBJTlNUQUxMTUVOVFNfS0VZV09SRCA9ICfXqtep15zXldedJztcblxuY29uc3QgREFURV9GT1JNQVQgPSAnREQvTU0vWVlZWSc7XG5cbmNvbnN0IGRlYnVnID0gZ2V0RGVidWcoJ2Jhc2UtaXNyYWNhcmQtYW1leCcpO1xuXG50eXBlIENvbXBhbnlTZXJ2aWNlT3B0aW9ucyA9IHtcbiAgc2VydmljZXNVcmw6IHN0cmluZztcbiAgY29tcGFueUNvZGU6IHN0cmluZztcbn07XG5cbnR5cGUgU2NyYXBlZEFjY291bnRzV2l0aEluZGV4ID0gUmVjb3JkPHN0cmluZywgVHJhbnNhY3Rpb25zQWNjb3VudCAmIHsgaW5kZXg6IG51bWJlciB9PjtcblxuaW50ZXJmYWNlIFNjcmFwZWRUcmFuc2FjdGlvbiB7XG4gIGRlYWxTdW1UeXBlOiBzdHJpbmc7XG4gIHZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQ6IHN0cmluZztcbiAgdm91Y2hlck51bWJlclJhdHo6IHN0cmluZztcbiAgbW9yZUluZm8/OiBzdHJpbmc7XG4gIGRlYWxTdW1PdXRib3VuZDogYm9vbGVhbjtcbiAgY3VycmVuY3lJZDogc3RyaW5nO1xuICBjdXJyZW50UGF5bWVudEN1cnJlbmN5OiBzdHJpbmc7XG4gIGRlYWxTdW06IG51bWJlcjtcbiAgZnVsbFBheW1lbnREYXRlPzogc3RyaW5nO1xuICBmdWxsUHVyY2hhc2VEYXRlPzogc3RyaW5nO1xuICBmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQ/OiBzdHJpbmc7XG4gIGZ1bGxTdXBwbGllck5hbWVIZWI6IHN0cmluZztcbiAgZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kOiBzdHJpbmc7XG4gIHBheW1lbnRTdW06IG51bWJlcjtcbiAgcGF5bWVudFN1bU91dGJvdW5kOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBTY3JhcGVkQWNjb3VudCB7XG4gIGluZGV4OiBudW1iZXI7XG4gIGFjY291bnROdW1iZXI6IHN0cmluZztcbiAgcHJvY2Vzc2VkRGF0ZTogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZExvZ2luVmFsaWRhdGlvbiB7XG4gIEhlYWRlcjoge1xuICAgIFN0YXR1czogc3RyaW5nO1xuICB9O1xuICBWYWxpZGF0ZUlkRGF0YUJlYW4/OiB7XG4gICAgdXNlck5hbWU/OiBzdHJpbmc7XG4gICAgcmV0dXJuQ29kZTogc3RyaW5nO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZEFjY291bnRzV2l0aGluUGFnZVJlc3BvbnNlIHtcbiAgSGVhZGVyOiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIERhc2hib2FyZE1vbnRoQmVhbj86IHtcbiAgICBjYXJkc0NoYXJnZXM6IHtcbiAgICAgIGNhcmRJbmRleDogc3RyaW5nO1xuICAgICAgY2FyZE51bWJlcjogc3RyaW5nO1xuICAgICAgYmlsbGluZ0RhdGU6IHN0cmluZztcbiAgICB9W107XG4gIH07XG59XG5cbmludGVyZmFjZSBTY3JhcGVkQ3VycmVudENhcmRUcmFuc2FjdGlvbnMge1xuICB0eG5Jc3JhZWw/OiBTY3JhcGVkVHJhbnNhY3Rpb25bXTtcbiAgdHhuQWJyb2FkPzogU2NyYXBlZFRyYW5zYWN0aW9uW107XG59XG5cbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb25EYXRhIHtcbiAgSGVhZGVyPzoge1xuICAgIFN0YXR1czogc3RyaW5nO1xuICB9O1xuICBQaXJ0ZXlJc2thXzIwNEJlYW4/OiB7XG4gICAgc2VjdG9yOiBzdHJpbmc7XG4gIH07XG5cbiAgQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbj86IFJlY29yZDxcbiAgICBzdHJpbmcsXG4gICAge1xuICAgICAgQ3VycmVudENhcmRUcmFuc2FjdGlvbnM6IFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9uc1tdO1xuICAgIH1cbiAgPjtcbn1cblxuZnVuY3Rpb24gZ2V0QWNjb3VudHNVcmwoc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCkge1xuICBjb25zdCBiaWxsaW5nRGF0ZSA9IG1vbnRoTW9tZW50LmZvcm1hdCgnWVlZWS1NTS1ERCcpO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlcnZpY2VzVXJsKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnRGFzaGJvYXJkTW9udGgnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2FjdGlvbkNvZGUnLCAnMCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnYmlsbGluZ0RhdGUnLCBiaWxsaW5nRGF0ZSk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdmb3JtYXQnLCAnSnNvbicpO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoQWNjb3VudHMocGFnZTogUGFnZSwgc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCk6IFByb21pc2U8U2NyYXBlZEFjY291bnRbXT4ge1xuICBjb25zdCBkYXRhVXJsID0gZ2V0QWNjb3VudHNVcmwoc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcbiAgZGVidWcoYGZldGNoaW5nIGFjY291bnRzIGZyb20gJHtkYXRhVXJsfWApO1xuICBjb25zdCBkYXRhUmVzdWx0ID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRBY2NvdW50c1dpdGhpblBhZ2VSZXNwb25zZT4ocGFnZSwgZGF0YVVybCk7XG4gIGlmIChkYXRhUmVzdWx0ICYmIF8uZ2V0KGRhdGFSZXN1bHQsICdIZWFkZXIuU3RhdHVzJykgPT09ICcxJyAmJiBkYXRhUmVzdWx0LkRhc2hib2FyZE1vbnRoQmVhbikge1xuICAgIGNvbnN0IHsgY2FyZHNDaGFyZ2VzIH0gPSBkYXRhUmVzdWx0LkRhc2hib2FyZE1vbnRoQmVhbjtcbiAgICBpZiAoY2FyZHNDaGFyZ2VzKSB7XG4gICAgICByZXR1cm4gY2FyZHNDaGFyZ2VzLm1hcChjYXJkQ2hhcmdlID0+IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpbmRleDogcGFyc2VJbnQoY2FyZENoYXJnZS5jYXJkSW5kZXgsIDEwKSxcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBjYXJkQ2hhcmdlLmNhcmROdW1iZXIsXG4gICAgICAgICAgcHJvY2Vzc2VkRGF0ZTogbW9tZW50KGNhcmRDaGFyZ2UuYmlsbGluZ0RhdGUsIERBVEVfRk9STUFUKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbXTtcbn1cblxuZnVuY3Rpb24gZ2V0VHJhbnNhY3Rpb25zVXJsKHNlcnZpY2VzVXJsOiBzdHJpbmcsIG1vbnRoTW9tZW50OiBNb21lbnQpIHtcbiAgY29uc3QgbW9udGggPSBtb250aE1vbWVudC5tb250aCgpICsgMTtcbiAgY29uc3QgeWVhciA9IG1vbnRoTW9tZW50LnllYXIoKTtcbiAgY29uc3QgbW9udGhTdHIgPSBtb250aCA8IDEwID8gYDAke21vbnRofWAgOiBtb250aC50b1N0cmluZygpO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlcnZpY2VzVXJsKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnQ2FyZHNUcmFuc2FjdGlvbnNMaXN0Jyk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdtb250aCcsIG1vbnRoU3RyKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3llYXInLCBgJHt5ZWFyfWApO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxdWlyZWREYXRlJywgJ04nKTtcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0Q3VycmVuY3koY3VycmVuY3lTdHI6IHN0cmluZykge1xuICBpZiAoY3VycmVuY3lTdHIgPT09IFNIRUtFTF9DVVJSRU5DWV9LRVlXT1JEIHx8IGN1cnJlbmN5U3RyID09PSBBTFRfU0hFS0VMX0NVUlJFTkNZKSB7XG4gICAgcmV0dXJuIFNIRUtFTF9DVVJSRU5DWTtcbiAgfVxuICByZXR1cm4gY3VycmVuY3lTdHI7XG59XG5cbmZ1bmN0aW9uIGdldEluc3RhbGxtZW50c0luZm8odHhuOiBTY3JhcGVkVHJhbnNhY3Rpb24pOiBUcmFuc2FjdGlvbkluc3RhbGxtZW50cyB8IHVuZGVmaW5lZCB7XG4gIGlmICghdHhuLm1vcmVJbmZvIHx8ICF0eG4ubW9yZUluZm8uaW5jbHVkZXMoSU5TVEFMTE1FTlRTX0tFWVdPUkQpKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBjb25zdCBtYXRjaGVzID0gdHhuLm1vcmVJbmZvLm1hdGNoKC9cXGQrL2cpO1xuICBpZiAoIW1hdGNoZXMgfHwgbWF0Y2hlcy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbnVtYmVyOiBwYXJzZUludChtYXRjaGVzWzBdLCAxMCksXG4gICAgdG90YWw6IHBhcnNlSW50KG1hdGNoZXNbMV0sIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZ2V0VHJhbnNhY3Rpb25UeXBlKHR4bjogU2NyYXBlZFRyYW5zYWN0aW9uKSB7XG4gIHJldHVybiBnZXRJbnN0YWxsbWVudHNJbmZvKHR4bikgPyBUcmFuc2FjdGlvblR5cGVzLkluc3RhbGxtZW50cyA6IFRyYW5zYWN0aW9uVHlwZXMuTm9ybWFsO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0VHJhbnNhY3Rpb25zKFxuICB0eG5zOiBTY3JhcGVkVHJhbnNhY3Rpb25bXSxcbiAgcHJvY2Vzc2VkRGF0ZTogc3RyaW5nLFxuICBvcHRpb25zPzogU2NyYXBlck9wdGlvbnMsXG4pOiBUcmFuc2FjdGlvbltdIHtcbiAgY29uc3QgZmlsdGVyZWRUeG5zID0gdHhucy5maWx0ZXIoXG4gICAgdHhuID0+XG4gICAgICB0eG4uZGVhbFN1bVR5cGUgIT09ICcxJyAmJiB0eG4udm91Y2hlck51bWJlclJhdHogIT09ICcwMDAwMDAwMDAnICYmIHR4bi52b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kICE9PSAnMDAwMDAwMDAwJyxcbiAgKTtcblxuICByZXR1cm4gZmlsdGVyZWRUeG5zLm1hcCh0eG4gPT4ge1xuICAgIGNvbnN0IGlzT3V0Ym91bmQgPSB0eG4uZGVhbFN1bU91dGJvdW5kO1xuICAgIGNvbnN0IHR4bkRhdGVTdHIgPSBpc091dGJvdW5kID8gdHhuLmZ1bGxQdXJjaGFzZURhdGVPdXRib3VuZCA6IHR4bi5mdWxsUHVyY2hhc2VEYXRlO1xuICAgIGNvbnN0IHR4bk1vbWVudCA9IG1vbWVudCh0eG5EYXRlU3RyLCBEQVRFX0ZPUk1BVCk7XG5cbiAgICBjb25zdCBjdXJyZW50UHJvY2Vzc2VkRGF0ZSA9IHR4bi5mdWxsUGF5bWVudERhdGVcbiAgICAgID8gbW9tZW50KHR4bi5mdWxsUGF5bWVudERhdGUsIERBVEVfRk9STUFUKS50b0lTT1N0cmluZygpXG4gICAgICA6IHByb2Nlc3NlZERhdGU7XG4gICAgY29uc3QgcmVzdWx0OiBUcmFuc2FjdGlvbiA9IHtcbiAgICAgIHR5cGU6IGdldFRyYW5zYWN0aW9uVHlwZSh0eG4pLFxuICAgICAgaWRlbnRpZmllcjogcGFyc2VJbnQoaXNPdXRib3VuZCA/IHR4bi52b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIDogdHhuLnZvdWNoZXJOdW1iZXJSYXR6LCAxMCksXG4gICAgICBkYXRlOiB0eG5Nb21lbnQudG9JU09TdHJpbmcoKSxcbiAgICAgIHByb2Nlc3NlZERhdGU6IGN1cnJlbnRQcm9jZXNzZWREYXRlLFxuICAgICAgb3JpZ2luYWxBbW91bnQ6IGlzT3V0Ym91bmQgPyAtdHhuLmRlYWxTdW1PdXRib3VuZCA6IC10eG4uZGVhbFN1bSxcbiAgICAgIG9yaWdpbmFsQ3VycmVuY3k6IGNvbnZlcnRDdXJyZW5jeSh0eG4uY3VycmVudFBheW1lbnRDdXJyZW5jeSA/PyB0eG4uY3VycmVuY3lJZCksXG4gICAgICBjaGFyZ2VkQW1vdW50OiBpc091dGJvdW5kID8gLXR4bi5wYXltZW50U3VtT3V0Ym91bmQgOiAtdHhuLnBheW1lbnRTdW0sXG4gICAgICBjaGFyZ2VkQ3VycmVuY3k6IGNvbnZlcnRDdXJyZW5jeSh0eG4uY3VycmVuY3lJZCksXG4gICAgICBkZXNjcmlwdGlvbjogaXNPdXRib3VuZCA/IHR4bi5mdWxsU3VwcGxpZXJOYW1lT3V0Ym91bmQgOiB0eG4uZnVsbFN1cHBsaWVyTmFtZUhlYixcbiAgICAgIG1lbW86IHR4bi5tb3JlSW5mbyB8fCAnJyxcbiAgICAgIGluc3RhbGxtZW50czogZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG4pIHx8IHVuZGVmaW5lZCxcbiAgICAgIHN0YXR1czogVHJhbnNhY3Rpb25TdGF0dXNlcy5Db21wbGV0ZWQsXG4gICAgfTtcblxuICAgIGlmIChvcHRpb25zPy5pbmNsdWRlUmF3VHJhbnNhY3Rpb24pIHtcbiAgICAgIHJlc3VsdC5yYXdUcmFuc2FjdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHR4bik7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoVHJhbnNhY3Rpb25zKFxuICBwYWdlOiBQYWdlLFxuICBvcHRpb25zOiBTY3JhcGVyT3B0aW9ucyxcbiAgY29tcGFueVNlcnZpY2VPcHRpb25zOiBDb21wYW55U2VydmljZU9wdGlvbnMsXG4gIHN0YXJ0TW9tZW50OiBNb21lbnQsXG4gIG1vbnRoTW9tZW50OiBNb21lbnQsXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleD4ge1xuICBjb25zdCBhY2NvdW50cyA9IGF3YWl0IGZldGNoQWNjb3VudHMocGFnZSwgY29tcGFueVNlcnZpY2VPcHRpb25zLnNlcnZpY2VzVXJsLCBtb250aE1vbWVudCk7XG4gIGNvbnN0IGRhdGFVcmwgPSBnZXRUcmFuc2FjdGlvbnNVcmwoY29tcGFueVNlcnZpY2VPcHRpb25zLnNlcnZpY2VzVXJsLCBtb250aE1vbWVudCk7XG4gIGF3YWl0IHNsZWVwKFJBVEVfTElNSVQuU0xFRVBfQkVUV0VFTik7XG4gIGRlYnVnKGBmZXRjaGluZyB0cmFuc2FjdGlvbnMgZnJvbSAke2RhdGFVcmx9IGZvciBtb250aCAke21vbnRoTW9tZW50LmZvcm1hdCgnWVlZWS1NTScpfWApO1xuICBjb25zdCBkYXRhUmVzdWx0ID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRUcmFuc2FjdGlvbkRhdGE+KHBhZ2UsIGRhdGFVcmwpO1xuICBpZiAoZGF0YVJlc3VsdCAmJiBfLmdldChkYXRhUmVzdWx0LCAnSGVhZGVyLlN0YXR1cycpID09PSAnMScgJiYgZGF0YVJlc3VsdC5DYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuKSB7XG4gICAgY29uc3QgYWNjb3VudFR4bnM6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleCA9IHt9O1xuICAgIGFjY291bnRzLmZvckVhY2goYWNjb3VudCA9PiB7XG4gICAgICBjb25zdCB0eG5Hcm91cHM6IFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9uc1tdIHwgdW5kZWZpbmVkID0gXy5nZXQoXG4gICAgICAgIGRhdGFSZXN1bHQsXG4gICAgICAgIGBDYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuLkluZGV4JHthY2NvdW50LmluZGV4fS5DdXJyZW50Q2FyZFRyYW5zYWN0aW9uc2AsXG4gICAgICApO1xuICAgICAgaWYgKHR4bkdyb3Vwcykge1xuICAgICAgICBsZXQgYWxsVHhuczogVHJhbnNhY3Rpb25bXSA9IFtdO1xuICAgICAgICB0eG5Hcm91cHMuZm9yRWFjaCh0eG5Hcm91cCA9PiB7XG4gICAgICAgICAgaWYgKHR4bkdyb3VwLnR4bklzcmFlbCkge1xuICAgICAgICAgICAgY29uc3QgdHhucyA9IGNvbnZlcnRUcmFuc2FjdGlvbnModHhuR3JvdXAudHhuSXNyYWVsLCBhY2NvdW50LnByb2Nlc3NlZERhdGUsIG9wdGlvbnMpO1xuICAgICAgICAgICAgYWxsVHhucy5wdXNoKC4uLnR4bnMpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuQWJyb2FkKSB7XG4gICAgICAgICAgICBjb25zdCB0eG5zID0gY29udmVydFRyYW5zYWN0aW9ucyh0eG5Hcm91cC50eG5BYnJvYWQsIGFjY291bnQucHJvY2Vzc2VkRGF0ZSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4udHhucyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoIW9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cykge1xuICAgICAgICAgIGFsbFR4bnMgPSBmaXhJbnN0YWxsbWVudHMoYWxsVHhucyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdGlvbnMub3V0cHV0RGF0YT8uZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlID8/IHRydWUpIHtcbiAgICAgICAgICBhbGxUeG5zID0gZmlsdGVyT2xkVHJhbnNhY3Rpb25zKGFsbFR4bnMsIHN0YXJ0TW9tZW50LCBvcHRpb25zLmNvbWJpbmVJbnN0YWxsbWVudHMgfHwgZmFsc2UpO1xuICAgICAgICB9XG4gICAgICAgIGFjY291bnRUeG5zW2FjY291bnQuYWNjb3VudE51bWJlcl0gPSB7XG4gICAgICAgICAgYWNjb3VudE51bWJlcjogYWNjb3VudC5hY2NvdW50TnVtYmVyLFxuICAgICAgICAgIGluZGV4OiBhY2NvdW50LmluZGV4LFxuICAgICAgICAgIHR4bnM6IGFsbFR4bnMsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIGFjY291bnRUeG5zO1xuICB9XG5cbiAgcmV0dXJuIHt9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24oXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgbW9udGg6IE1vbWVudCxcbiAgYWNjb3VudEluZGV4OiBudW1iZXIsXG4gIHRyYW5zYWN0aW9uOiBUcmFuc2FjdGlvbixcbik6IFByb21pc2U8VHJhbnNhY3Rpb24+IHtcbiAgY29uc3QgdXJsID0gbmV3IFVSTChvcHRpb25zLnNlcnZpY2VzVXJsKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnUGlydGV5SXNrYV8yMDQnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ0NhcmRJbmRleCcsIGFjY291bnRJbmRleC50b1N0cmluZygpKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3Nob3ZhclJhdHonLCB0cmFuc2FjdGlvbi5pZGVudGlmaWVyIS50b1N0cmluZygpKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ21vZWRDaGl1dicsIG1vbnRoLmZvcm1hdCgnTU1ZWVlZJykpO1xuXG4gIGRlYnVnKGBmZXRjaGluZyBleHRyYSBzY3JhcCBmb3IgdHJhbnNhY3Rpb24gJHt0cmFuc2FjdGlvbi5pZGVudGlmaWVyfSBmb3IgbW9udGggJHttb250aC5mb3JtYXQoJ1lZWVktTU0nKX1gKTtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkVHJhbnNhY3Rpb25EYXRhPihwYWdlLCB1cmwudG9TdHJpbmcoKSk7XG4gIGlmICghZGF0YSkge1xuICAgIHJldHVybiB0cmFuc2FjdGlvbjtcbiAgfVxuXG4gIGNvbnN0IHJhd0NhdGVnb3J5ID0gXy5nZXQoZGF0YSwgJ1BpcnRleUlza2FfMjA0QmVhbi5zZWN0b3InKSA/PyAnJztcbiAgcmV0dXJuIHtcbiAgICAuLi50cmFuc2FjdGlvbixcbiAgICBjYXRlZ29yeTogcmF3Q2F0ZWdvcnkudHJpbSgpLFxuICAgIHJhd1RyYW5zYWN0aW9uOiBnZXRSYXdUcmFuc2FjdGlvbihkYXRhLCB0cmFuc2FjdGlvbiksXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEV4dHJhU2NyYXBBY2NvdW50KFxuICBwYWdlOiBQYWdlLFxuICBvcHRpb25zOiBDb21wYW55U2VydmljZU9wdGlvbnMsXG4gIGFjY291bnRNYXA6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleCxcbiAgbW9udGg6IG1vbWVudC5Nb21lbnQsXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleD4ge1xuICBjb25zdCBhY2NvdW50czogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W3N0cmluZ11bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGFjY291bnQgb2YgT2JqZWN0LnZhbHVlcyhhY2NvdW50TWFwKSkge1xuICAgIGRlYnVnKFxuICAgICAgYGdldCBleHRyYSBzY3JhcCBmb3IgJHthY2NvdW50LmFjY291bnROdW1iZXJ9IHdpdGggJHthY2NvdW50LnR4bnMubGVuZ3RofSB0cmFuc2FjdGlvbnNgLFxuICAgICAgbW9udGguZm9ybWF0KCdZWVlZLU1NJyksXG4gICAgKTtcbiAgICBjb25zdCB0eG5zOiBUcmFuc2FjdGlvbltdID0gW107XG4gICAgZm9yIChjb25zdCB0eG5zQ2h1bmsgb2YgXy5jaHVuayhhY2NvdW50LnR4bnMsIFJBVEVfTElNSVQuVFJBTlNBQ1RJT05TX0JBVENIX1NJWkUpKSB7XG4gICAgICBkZWJ1ZyhgcHJvY2Vzc2luZyBjaHVuayBvZiAke3R4bnNDaHVuay5sZW5ndGh9IHRyYW5zYWN0aW9ucyBmb3IgYWNjb3VudCAke2FjY291bnQuYWNjb3VudE51bWJlcn1gKTtcbiAgICAgIGNvbnN0IHVwZGF0ZWRUeG5zID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIHR4bnNDaHVuay5tYXAodCA9PiBnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24ocGFnZSwgb3B0aW9ucywgbW9udGgsIGFjY291bnQuaW5kZXgsIHQpKSxcbiAgICAgICk7XG4gICAgICBhd2FpdCBzbGVlcChSQVRFX0xJTUlULlNMRUVQX0JFVFdFRU4pO1xuICAgICAgdHhucy5wdXNoKC4uLnVwZGF0ZWRUeG5zKTtcbiAgICB9XG4gICAgYWNjb3VudHMucHVzaCh7IC4uLmFjY291bnQsIHR4bnMgfSk7XG4gIH1cblxuICByZXR1cm4gYWNjb3VudHMucmVkdWNlKChtLCB4KSA9PiAoeyAuLi5tLCBbeC5hY2NvdW50TnVtYmVyXTogeCB9KSwge30pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbihcbiAgc2NyYXBlck9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBhY2NvdW50c1dpdGhJbmRleDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10sXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgYWxsTW9udGhzOiBtb21lbnQuTW9tZW50W10sXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdPiB7XG4gIGlmIChcbiAgICAhc2NyYXBlck9wdGlvbnMuYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24gfHxcbiAgICBzY3JhcGVyT3B0aW9ucy5vcHRJbkZlYXR1cmVzPy5pbmNsdWRlcygnaXNyYWNhcmQtYW1leDpza2lwQWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24nKVxuICApIHtcbiAgICByZXR1cm4gYWNjb3VudHNXaXRoSW5kZXg7XG4gIH1cbiAgcmV0dXJuIHJ1blNlcmlhbChhY2NvdW50c1dpdGhJbmRleC5tYXAoKGEsIGkpID0+ICgpID0+IGdldEV4dHJhU2NyYXBBY2NvdW50KHBhZ2UsIG9wdGlvbnMsIGEsIGFsbE1vbnRoc1tpXSkpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGxUcmFuc2FjdGlvbnMoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBjb21wYW55U2VydmljZU9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgc3RhcnRNb21lbnQ6IE1vbWVudCxcbikge1xuICBjb25zdCBmdXR1cmVNb250aHNUb1NjcmFwZSA9IG9wdGlvbnMuZnV0dXJlTW9udGhzVG9TY3JhcGUgPz8gMTtcbiAgY29uc3QgYWxsTW9udGhzID0gZ2V0QWxsTW9udGhNb21lbnRzKHN0YXJ0TW9tZW50LCBmdXR1cmVNb250aHNUb1NjcmFwZSk7XG4gIGNvbnN0IHJlc3VsdHM6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdID0gYXdhaXQgcnVuU2VyaWFsKFxuICAgIGFsbE1vbnRocy5tYXAobW9udGhNb21lbnQgPT4gKCkgPT4ge1xuICAgICAgcmV0dXJuIGZldGNoVHJhbnNhY3Rpb25zKHBhZ2UsIG9wdGlvbnMsIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucywgc3RhcnRNb21lbnQsIG1vbnRoTW9tZW50KTtcbiAgICB9KSxcbiAgKTtcblxuICBjb25zdCBmaW5hbFJlc3VsdCA9IGF3YWl0IGdldEFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uKFxuICAgIG9wdGlvbnMsXG4gICAgcmVzdWx0cyxcbiAgICBwYWdlLFxuICAgIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgICBhbGxNb250aHMsXG4gICk7XG4gIGNvbnN0IGNvbWJpbmVkVHhuczogUmVjb3JkPHN0cmluZywgVHJhbnNhY3Rpb25bXT4gPSB7fTtcblxuICBmaW5hbFJlc3VsdC5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgT2JqZWN0LmtleXMocmVzdWx0KS5mb3JFYWNoKGFjY291bnROdW1iZXIgPT4ge1xuICAgICAgbGV0IHR4bnNGb3JBY2NvdW50ID0gY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdO1xuICAgICAgaWYgKCF0eG5zRm9yQWNjb3VudCkge1xuICAgICAgICB0eG5zRm9yQWNjb3VudCA9IFtdO1xuICAgICAgICBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0gPSB0eG5zRm9yQWNjb3VudDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHRvQmVBZGRlZFR4bnMgPSByZXN1bHRbYWNjb3VudE51bWJlcl0udHhucztcbiAgICAgIGNvbWJpbmVkVHhuc1thY2NvdW50TnVtYmVyXS5wdXNoKC4uLnRvQmVBZGRlZFR4bnMpO1xuICAgIH0pO1xuICB9KTtcblxuICBjb25zdCBhY2NvdW50cyA9IE9iamVjdC5rZXlzKGNvbWJpbmVkVHhucykubWFwKGFjY291bnROdW1iZXIgPT4ge1xuICAgIHJldHVybiB7XG4gICAgICBhY2NvdW50TnVtYmVyLFxuICAgICAgdHhuczogY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdLFxuICAgIH07XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBhY2NvdW50cyxcbiAgfTtcbn1cblxudHlwZSBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyA9IHsgaWQ6IHN0cmluZzsgcGFzc3dvcmQ6IHN0cmluZzsgY2FyZDZEaWdpdHM6IHN0cmluZyB9O1xuY2xhc3MgSXNyYWNhcmRBbWV4QmFzZVNjcmFwZXIgZXh0ZW5kcyBCYXNlU2NyYXBlcldpdGhCcm93c2VyPFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzPiB7XG4gIHByaXZhdGUgYmFzZVVybDogc3RyaW5nO1xuXG4gIHByaXZhdGUgY29tcGFueUNvZGU6IHN0cmluZztcblxuICBwcml2YXRlIHNlcnZpY2VzVXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogU2NyYXBlck9wdGlvbnMsIGJhc2VVcmw6IHN0cmluZywgY29tcGFueUNvZGU6IHN0cmluZykge1xuICAgIHN1cGVyKG9wdGlvbnMpO1xuXG4gICAgdGhpcy5iYXNlVXJsID0gYmFzZVVybDtcbiAgICB0aGlzLmNvbXBhbnlDb2RlID0gY29tcGFueUNvZGU7XG4gICAgdGhpcy5zZXJ2aWNlc1VybCA9IGAke2Jhc2VVcmx9L3NlcnZpY2VzL1Byb3h5UmVxdWVzdEhhbmRsZXIuYXNoeGA7XG4gIH1cblxuICBhc3luYyBsb2dpbihjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpOiBQcm9taXNlPFNjcmFwZXJTY3JhcGluZ1Jlc3VsdD4ge1xuICAgIGF3YWl0IG1hc2tIZWFkbGVzc1VzZXJBZ2VudCh0aGlzLnBhZ2UpO1xuXG4gICAgYXdhaXQgdGhpcy5wYWdlLnNldFJlcXVlc3RJbnRlcmNlcHRpb24odHJ1ZSk7XG4gICAgdGhpcy5wYWdlLm9uKCdyZXF1ZXN0JywgcmVxdWVzdCA9PiB7XG4gICAgICBpZiAocmVxdWVzdC51cmwoKS5pbmNsdWRlcygnZGV0ZWN0b3ItZG9tLm1pbi5qcycpKSB7XG4gICAgICAgIGRlYnVnKCdmb3JjZSBhYm9ydCBmb3IgcmVxdWVzdCBkbyBkb3dubG9hZCBkZXRlY3Rvci1kb20ubWluLmpzIHJlc291cmNlJyk7XG4gICAgICAgIHZvaWQgcmVxdWVzdC5hYm9ydCh1bmRlZmluZWQsIGludGVyY2VwdGlvblByaW9yaXRpZXMuYWJvcnQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdm9pZCByZXF1ZXN0LmNvbnRpbnVlKHVuZGVmaW5lZCwgaW50ZXJjZXB0aW9uUHJpb3JpdGllcy5jb250aW51ZSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBOYXZpZ2F0ZSB0byBob21lcGFnZSBmaXJzdCB0byBlc3RhYmxpc2ggc2Vzc2lvblxuICAgIGRlYnVnKCd3YXJtaW5nIHVwIGJyb3dzZXIgd2l0aCBob21lcGFnZScpO1xuICAgIGF3YWl0IHRoaXMubmF2aWdhdGVUbyh0aGlzLmJhc2VVcmwsICdkb21jb250ZW50bG9hZGVkJyk7XG4gICAgYXdhaXQgc2xlZXAoMTAwMCk7XG5cbiAgICBkZWJ1ZygnbmF2aWdhdGluZyB0byBsb2dpbiBwYWdlJyk7XG4gICAgYXdhaXQgdGhpcy5uYXZpZ2F0ZVRvKGAke3RoaXMuYmFzZVVybH0vcGVyc29uYWxhcmVhL0xvZ2luYCk7XG5cbiAgICAvLyBDbGljayBvbiBcIteQ15Ug15vXoNeZ16HXlCDXotedINeh15nXodee15Qg16fXkdeV16LXlFwiIHRvIG9wZW4gdGhlIHBhc3N3b3JkIGxvZ2luIGZvcm1cbiAgICBkZWJ1ZygnY2xpY2tpbmcgb24gcGFzc3dvcmQgbG9naW4gbGluaycpO1xuICAgIGF3YWl0IHRoaXMucGFnZS53YWl0Rm9yU2VsZWN0b3IoJyNmbGlwJywgeyB2aXNpYmxlOiB0cnVlLCB0aW1lb3V0OiAzMDAwMCB9KTtcbiAgICBhd2FpdCB0aGlzLnBhZ2UuY2xpY2soJyNmbGlwJyk7XG5cbiAgICAvLyBXYWl0IGZvciB0aGUgcGFzc3dvcmQgZm9ybSB0byBhcHBlYXIgYWZ0ZXIgYW5pbWF0aW9uXG4gICAgZGVidWcoJ3dhaXRpbmcgZm9yIHBhc3N3b3JkIGZvcm0gdG8gYXBwZWFyJyk7XG4gICAgYXdhaXQgdGhpcy5wYWdlLndhaXRGb3JTZWxlY3RvcignI290cExvZ2luSWRfSUQnLCB7IHZpc2libGU6IHRydWUsIHRpbWVvdXQ6IDMwMDAwIH0pO1xuICAgIGF3YWl0IHNsZWVwKDEwMDApO1xuXG4gICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9nZ2luZ0luKTtcblxuICAgIGNvbnN0IHZhbGlkYXRlVXJsID0gYCR7dGhpcy5zZXJ2aWNlc1VybH0/cmVxTmFtZT1WYWxpZGF0ZUlkRGF0YWA7XG4gICAgY29uc3QgdmFsaWRhdGVSZXF1ZXN0ID0ge1xuICAgICAgaWQ6IGNyZWRlbnRpYWxzLmlkLFxuICAgICAgY2FyZFN1ZmZpeDogY3JlZGVudGlhbHMuY2FyZDZEaWdpdHMsXG4gICAgICBjb3VudHJ5Q29kZTogQ09VTlRSWV9DT0RFLFxuICAgICAgaWRUeXBlOiBJRF9UWVBFLFxuICAgICAgY2hlY2tMZXZlbDogJzEnLFxuICAgICAgY29tcGFueUNvZGU6IHRoaXMuY29tcGFueUNvZGUsXG4gICAgfTtcbiAgICBkZWJ1ZygnbG9nZ2luZyBpbiB3aXRoIHZhbGlkYXRlIHJlcXVlc3QnKTtcbiAgICBjb25zdCB2YWxpZGF0ZVJlc3VsdCA9IGF3YWl0IGZldGNoUG9zdFdpdGhpblBhZ2U8U2NyYXBlZExvZ2luVmFsaWRhdGlvbj4odGhpcy5wYWdlLCB2YWxpZGF0ZVVybCwgdmFsaWRhdGVSZXF1ZXN0KTtcbiAgICBpZiAoXG4gICAgICAhdmFsaWRhdGVSZXN1bHQgfHxcbiAgICAgICF2YWxpZGF0ZVJlc3VsdC5IZWFkZXIgfHxcbiAgICAgIHZhbGlkYXRlUmVzdWx0LkhlYWRlci5TdGF0dXMgIT09ICcxJyB8fFxuICAgICAgIXZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhblxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCd1bmtub3duIGVycm9yIGR1cmluZyBsb2dpbicpO1xuICAgIH1cblxuICAgIGNvbnN0IHZhbGlkYXRlUmV0dXJuQ29kZSA9IHZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhbi5yZXR1cm5Db2RlO1xuICAgIGRlYnVnKGB1c2VyIHZhbGlkYXRlIHdpdGggcmV0dXJuIGNvZGUgJyR7dmFsaWRhdGVSZXR1cm5Db2RlfSdgKTtcbiAgICBpZiAodmFsaWRhdGVSZXR1cm5Db2RlID09PSAnMScpIHtcbiAgICAgIGNvbnN0IHsgdXNlck5hbWUgfSA9IHZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhbjtcblxuICAgICAgY29uc3QgbG9naW5VcmwgPSBgJHt0aGlzLnNlcnZpY2VzVXJsfT9yZXFOYW1lPXBlcmZvcm1Mb2dvbklgO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgICAgS29kTWlzaHRhbWVzaDogdXNlck5hbWUsXG4gICAgICAgIE1pc3BhclppaHV5OiBjcmVkZW50aWFscy5pZCxcbiAgICAgICAgU2lzbWE6IGNyZWRlbnRpYWxzLnBhc3N3b3JkLFxuICAgICAgICBjYXJkU3VmZml4OiBjcmVkZW50aWFscy5jYXJkNkRpZ2l0cyxcbiAgICAgICAgY291bnRyeUNvZGU6IENPVU5UUllfQ09ERSxcbiAgICAgICAgaWRUeXBlOiBJRF9UWVBFLFxuICAgICAgfTtcbiAgICAgIGRlYnVnKCd1c2VyIGxvZ2luIHN0YXJ0ZWQnKTtcbiAgICAgIGNvbnN0IGxvZ2luUmVzdWx0ID0gYXdhaXQgZmV0Y2hQb3N0V2l0aGluUGFnZTx7IHN0YXR1czogc3RyaW5nIH0+KHRoaXMucGFnZSwgbG9naW5VcmwsIHJlcXVlc3QpO1xuICAgICAgZGVidWcoYHVzZXIgbG9naW4gd2l0aCBzdGF0dXMgJyR7bG9naW5SZXN1bHQ/LnN0YXR1c30nYCwgbG9naW5SZXN1bHQpO1xuXG4gICAgICBpZiAobG9naW5SZXN1bHQgJiYgbG9naW5SZXN1bHQuc3RhdHVzID09PSAnMScpIHtcbiAgICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5TdWNjZXNzKTtcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgICAgfVxuXG4gICAgICBpZiAobG9naW5SZXN1bHQgJiYgbG9naW5SZXN1bHQuc3RhdHVzID09PSAnMycpIHtcbiAgICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuQ2hhbmdlUGFzc3dvcmQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuQ2hhbmdlUGFzc3dvcmQsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2luRmFpbGVkKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkludmFsaWRQYXNzd29yZCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKHZhbGlkYXRlUmV0dXJuQ29kZSA9PT0gJzQnKSB7XG4gICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5DaGFuZ2VQYXNzd29yZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5DaGFuZ2VQYXNzd29yZCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5GYWlsZWQpO1xuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuSW52YWxpZFBhc3N3b3JkLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBmZXRjaERhdGEoKSB7XG4gICAgY29uc3QgZGVmYXVsdFN0YXJ0TW9tZW50ID0gbW9tZW50KCkuc3VidHJhY3QoMSwgJ3llYXJzJyk7XG4gICAgY29uc3Qgc3RhcnREYXRlID0gdGhpcy5vcHRpb25zLnN0YXJ0RGF0ZSB8fCBkZWZhdWx0U3RhcnRNb21lbnQudG9EYXRlKCk7XG4gICAgY29uc3Qgc3RhcnRNb21lbnQgPSBtb21lbnQubWF4KGRlZmF1bHRTdGFydE1vbWVudCwgbW9tZW50KHN0YXJ0RGF0ZSkpO1xuXG4gICAgcmV0dXJuIGZldGNoQWxsVHJhbnNhY3Rpb25zKFxuICAgICAgdGhpcy5wYWdlLFxuICAgICAgdGhpcy5vcHRpb25zLFxuICAgICAge1xuICAgICAgICBzZXJ2aWNlc1VybDogdGhpcy5zZXJ2aWNlc1VybCxcbiAgICAgICAgY29tcGFueUNvZGU6IHRoaXMuY29tcGFueUNvZGUsXG4gICAgICB9LFxuICAgICAgc3RhcnRNb21lbnQsXG4gICAgKTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBJc3JhY2FyZEFtZXhCYXNlU2NyYXBlcjtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsSUFBQUEsT0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBRUEsSUFBQUUsVUFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsWUFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksTUFBQSxHQUFBTCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssTUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0sTUFBQSxHQUFBTixPQUFBO0FBQ0EsSUFBQU8sYUFBQSxHQUFBUCxPQUFBO0FBQ0EsSUFBQVEsUUFBQSxHQUFBUixPQUFBO0FBQ0EsSUFBQVMsY0FBQSxHQUFBVCxPQUFBO0FBT0EsSUFBQVUsdUJBQUEsR0FBQVYsT0FBQTtB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