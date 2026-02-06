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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9kYXNoIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbW9tZW50IiwiX2NvbnN0YW50cyIsIl9kZWZpbml0aW9ucyIsIl9kYXRlcyIsIl9kZWJ1ZyIsIl9mZXRjaCIsIl90cmFuc2FjdGlvbnMiLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMyIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXJyb3JzIiwiX2Jyb3dzZXIiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJSQVRFX0xJTUlUIiwiU0xFRVBfQkVUV0VFTiIsIlRSQU5TQUNUSU9OU19CQVRDSF9TSVpFIiwiQ09VTlRSWV9DT0RFIiwiSURfVFlQRSIsIklOU1RBTExNRU5UU19LRVlXT1JEIiwiREFURV9GT1JNQVQiLCJkZWJ1ZyIsImdldERlYnVnIiwiZ2V0QWNjb3VudHNVcmwiLCJzZXJ2aWNlc1VybCIsIm1vbnRoTW9tZW50IiwiYmlsbGluZ0RhdGUiLCJmb3JtYXQiLCJ1cmwiLCJVUkwiLCJzZWFyY2hQYXJhbXMiLCJzZXQiLCJ0b1N0cmluZyIsImZldGNoQWNjb3VudHMiLCJwYWdlIiwiZGF0YVVybCIsImRhdGFSZXN1bHQiLCJmZXRjaEdldFdpdGhpblBhZ2UiLCJfIiwiZ2V0IiwiRGFzaGJvYXJkTW9udGhCZWFuIiwiY2FyZHNDaGFyZ2VzIiwibWFwIiwiY2FyZENoYXJnZSIsImluZGV4IiwicGFyc2VJbnQiLCJjYXJkSW5kZXgiLCJhY2NvdW50TnVtYmVyIiwiY2FyZE51bWJlciIsInByb2Nlc3NlZERhdGUiLCJtb21lbnQiLCJ0b0lTT1N0cmluZyIsImdldFRyYW5zYWN0aW9uc1VybCIsIm1vbnRoIiwieWVhciIsIm1vbnRoU3RyIiwiY29udmVydEN1cnJlbmN5IiwiY3VycmVuY3lTdHIiLCJTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCIsIkFMVF9TSEVLRUxfQ1VSUkVOQ1kiLCJTSEVLRUxfQ1VSUkVOQ1kiLCJnZXRJbnN0YWxsbWVudHNJbmZvIiwidHhuIiwibW9yZUluZm8iLCJpbmNsdWRlcyIsInVuZGVmaW5lZCIsIm1hdGNoZXMiLCJtYXRjaCIsImxlbmd0aCIsIm51bWJlciIsInRvdGFsIiwiZ2V0VHJhbnNhY3Rpb25UeXBlIiwiVHJhbnNhY3Rpb25UeXBlcyIsIkluc3RhbGxtZW50cyIsIk5vcm1hbCIsImNvbnZlcnRUcmFuc2FjdGlvbnMiLCJ0eG5zIiwib3B0aW9ucyIsImZpbHRlcmVkVHhucyIsImZpbHRlciIsImRlYWxTdW1UeXBlIiwidm91Y2hlck51bWJlclJhdHoiLCJ2b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIiwiaXNPdXRib3VuZCIsImRlYWxTdW1PdXRib3VuZCIsInR4bkRhdGVTdHIiLCJmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQiLCJmdWxsUHVyY2hhc2VEYXRlIiwidHhuTW9tZW50IiwiY3VycmVudFByb2Nlc3NlZERhdGUiLCJmdWxsUGF5bWVudERhdGUiLCJyZXN1bHQiLCJ0eXBlIiwiaWRlbnRpZmllciIsImRhdGUiLCJvcmlnaW5hbEFtb3VudCIsImRlYWxTdW0iLCJvcmlnaW5hbEN1cnJlbmN5IiwiY3VycmVudFBheW1lbnRDdXJyZW5jeSIsImN1cnJlbmN5SWQiLCJjaGFyZ2VkQW1vdW50IiwicGF5bWVudFN1bU91dGJvdW5kIiwicGF5bWVudFN1bSIsImNoYXJnZWRDdXJyZW5jeSIsImRlc2NyaXB0aW9uIiwiZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIiwiZnVsbFN1cHBsaWVyTmFtZUhlYiIsIm1lbW8iLCJpbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiQ29tcGxldGVkIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsImZldGNoVHJhbnNhY3Rpb25zIiwiY29tcGFueVNlcnZpY2VPcHRpb25zIiwic3RhcnRNb21lbnQiLCJhY2NvdW50cyIsInNsZWVwIiwiQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbiIsImFjY291bnRUeG5zIiwiZm9yRWFjaCIsImFjY291bnQiLCJ0eG5Hcm91cHMiLCJhbGxUeG5zIiwidHhuR3JvdXAiLCJ0eG5Jc3JhZWwiLCJwdXNoIiwidHhuQWJyb2FkIiwiY29tYmluZUluc3RhbGxtZW50cyIsImZpeEluc3RhbGxtZW50cyIsIm91dHB1dERhdGEiLCJlbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUiLCJmaWx0ZXJPbGRUcmFuc2FjdGlvbnMiLCJnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24iLCJhY2NvdW50SW5kZXgiLCJ0cmFuc2FjdGlvbiIsImRhdGEiLCJyYXdDYXRlZ29yeSIsImNhdGVnb3J5IiwidHJpbSIsImdldEV4dHJhU2NyYXBBY2NvdW50IiwiYWNjb3VudE1hcCIsIk9iamVjdCIsInZhbHVlcyIsInR4bnNDaHVuayIsImNodW5rIiwidXBkYXRlZFR4bnMiLCJQcm9taXNlIiwiYWxsIiwidCIsInJlZHVjZSIsIm0iLCJ4IiwiZ2V0QWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJzY3JhcGVyT3B0aW9ucyIsImFjY291bnRzV2l0aEluZGV4IiwiYWxsTW9udGhzIiwiYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJvcHRJbkZlYXR1cmVzIiwicnVuU2VyaWFsIiwiYSIsImkiLCJmZXRjaEFsbFRyYW5zYWN0aW9ucyIsImZ1dHVyZU1vbnRoc1RvU2NyYXBlIiwiZ2V0QWxsTW9udGhNb21lbnRzIiwicmVzdWx0cyIsImZpbmFsUmVzdWx0IiwiY29tYmluZWRUeG5zIiwia2V5cyIsInR4bnNGb3JBY2NvdW50IiwidG9CZUFkZGVkVHhucyIsInN1Y2Nlc3MiLCJJc3JhY2FyZEFtZXhCYXNlU2NyYXBlciIsIkJhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJjb25zdHJ1Y3RvciIsImJhc2VVcmwiLCJjb21wYW55Q29kZSIsImxvZ2luIiwiY3JlZGVudGlhbHMiLCJtYXNrSGVhZGxlc3NVc2VyQWdlbnQiLCJzZXRSZXF1ZXN0SW50ZXJjZXB0aW9uIiwib24iLCJyZXF1ZXN0IiwiYWJvcnQiLCJpbnRlcmNlcHRpb25Qcmlvcml0aWVzIiwiY29udGludWUiLCJuYXZpZ2F0ZVRvIiwiZW1pdFByb2dyZXNzIiwiU2NyYXBlclByb2dyZXNzVHlwZXMiLCJMb2dnaW5nSW4iLCJ2YWxpZGF0ZVVybCIsInZhbGlkYXRlUmVxdWVzdCIsImlkIiwiY2FyZFN1ZmZpeCIsImNhcmQ2RGlnaXRzIiwiY291bnRyeUNvZGUiLCJpZFR5cGUiLCJjaGVja0xldmVsIiwidmFsaWRhdGVSZXN1bHQiLCJmZXRjaFBvc3RXaXRoaW5QYWdlIiwiSGVhZGVyIiwiU3RhdHVzIiwiVmFsaWRhdGVJZERhdGFCZWFuIiwiRXJyb3IiLCJ2YWxpZGF0ZVJldHVybkNvZGUiLCJyZXR1cm5Db2RlIiwidXNlck5hbWUiLCJsb2dpblVybCIsIktvZE1pc2h0YW1lc2giLCJNaXNwYXJaaWh1eSIsIlNpc21hIiwicGFzc3dvcmQiLCJsb2dpblJlc3VsdCIsIkxvZ2luU3VjY2VzcyIsIkNoYW5nZVBhc3N3b3JkIiwiZXJyb3JUeXBlIiwiU2NyYXBlckVycm9yVHlwZXMiLCJMb2dpbkZhaWxlZCIsIkludmFsaWRQYXNzd29yZCIsImZldGNoRGF0YSIsImRlZmF1bHRTdGFydE1vbWVudCIsInN1YnRyYWN0Iiwic3RhcnREYXRlIiwidG9EYXRlIiwibWF4IiwiX2RlZmF1bHQiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL3NjcmFwZXJzL2Jhc2UtaXNyYWNhcmQtYW1leC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IG1vbWVudCwgeyB0eXBlIE1vbWVudCB9IGZyb20gJ21vbWVudCc7XG5pbXBvcnQgeyB0eXBlIFBhZ2UgfSBmcm9tICdwdXBwZXRlZXInO1xuaW1wb3J0IHsgQUxUX1NIRUtFTF9DVVJSRU5DWSwgU0hFS0VMX0NVUlJFTkNZLCBTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCB9IGZyb20gJy4uL2NvbnN0YW50cyc7XG5pbXBvcnQgeyBTY3JhcGVyUHJvZ3Jlc3NUeXBlcyB9IGZyb20gJy4uL2RlZmluaXRpb25zJztcbmltcG9ydCBnZXRBbGxNb250aE1vbWVudHMgZnJvbSAnLi4vaGVscGVycy9kYXRlcyc7XG5pbXBvcnQgeyBnZXREZWJ1ZyB9IGZyb20gJy4uL2hlbHBlcnMvZGVidWcnO1xuaW1wb3J0IHsgZmV0Y2hHZXRXaXRoaW5QYWdlLCBmZXRjaFBvc3RXaXRoaW5QYWdlIH0gZnJvbSAnLi4vaGVscGVycy9mZXRjaCc7XG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGZpeEluc3RhbGxtZW50cywgZ2V0UmF3VHJhbnNhY3Rpb24gfSBmcm9tICcuLi9oZWxwZXJzL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBydW5TZXJpYWwsIHNsZWVwIH0gZnJvbSAnLi4vaGVscGVycy93YWl0aW5nJztcbmltcG9ydCB7XG4gIFRyYW5zYWN0aW9uU3RhdHVzZXMsXG4gIFRyYW5zYWN0aW9uVHlwZXMsXG4gIHR5cGUgVHJhbnNhY3Rpb24sXG4gIHR5cGUgVHJhbnNhY3Rpb25JbnN0YWxsbWVudHMsXG4gIHR5cGUgVHJhbnNhY3Rpb25zQWNjb3VudCxcbn0gZnJvbSAnLi4vdHJhbnNhY3Rpb25zJztcbmltcG9ydCB7IEJhc2VTY3JhcGVyV2l0aEJyb3dzZXIgfSBmcm9tICcuL2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXInO1xuaW1wb3J0IHsgU2NyYXBlckVycm9yVHlwZXMgfSBmcm9tICcuL2Vycm9ycyc7XG5pbXBvcnQgeyB0eXBlIFNjcmFwZXJPcHRpb25zLCB0eXBlIFNjcmFwZXJTY3JhcGluZ1Jlc3VsdCB9IGZyb20gJy4vaW50ZXJmYWNlJztcbmltcG9ydCB7IGludGVyY2VwdGlvblByaW9yaXRpZXMsIG1hc2tIZWFkbGVzc1VzZXJBZ2VudCB9IGZyb20gJy4uL2hlbHBlcnMvYnJvd3Nlcic7XG5cbmNvbnN0IFJBVEVfTElNSVQgPSB7XG4gIFNMRUVQX0JFVFdFRU46IDEwMDAsXG4gIFRSQU5TQUNUSU9OU19CQVRDSF9TSVpFOiAxMCxcbn0gYXMgY29uc3Q7XG5cbmNvbnN0IENPVU5UUllfQ09ERSA9ICcyMTInO1xuY29uc3QgSURfVFlQRSA9ICcxJztcbmNvbnN0IElOU1RBTExNRU5UU19LRVlXT1JEID0gJ9eq16nXnNeV150nO1xuXG5jb25zdCBEQVRFX0ZPUk1BVCA9ICdERC9NTS9ZWVlZJztcblxuY29uc3QgZGVidWcgPSBnZXREZWJ1ZygnYmFzZS1pc3JhY2FyZC1hbWV4Jyk7XG5cbnR5cGUgQ29tcGFueVNlcnZpY2VPcHRpb25zID0ge1xuICBzZXJ2aWNlc1VybDogc3RyaW5nO1xuICBjb21wYW55Q29kZTogc3RyaW5nO1xufTtcblxudHlwZSBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXggPSBSZWNvcmQ8c3RyaW5nLCBUcmFuc2FjdGlvbnNBY2NvdW50ICYgeyBpbmRleDogbnVtYmVyIH0+O1xuXG5pbnRlcmZhY2UgU2NyYXBlZFRyYW5zYWN0aW9uIHtcbiAgZGVhbFN1bVR5cGU6IHN0cmluZztcbiAgdm91Y2hlck51bWJlclJhdHpPdXRib3VuZDogc3RyaW5nO1xuICB2b3VjaGVyTnVtYmVyUmF0ejogc3RyaW5nO1xuICBtb3JlSW5mbz86IHN0cmluZztcbiAgZGVhbFN1bU91dGJvdW5kOiBib29sZWFuO1xuICBjdXJyZW5jeUlkOiBzdHJpbmc7XG4gIGN1cnJlbnRQYXltZW50Q3VycmVuY3k6IHN0cmluZztcbiAgZGVhbFN1bTogbnVtYmVyO1xuICBmdWxsUGF5bWVudERhdGU/OiBzdHJpbmc7XG4gIGZ1bGxQdXJjaGFzZURhdGU/OiBzdHJpbmc7XG4gIGZ1bGxQdXJjaGFzZURhdGVPdXRib3VuZD86IHN0cmluZztcbiAgZnVsbFN1cHBsaWVyTmFtZUhlYjogc3RyaW5nO1xuICBmdWxsU3VwcGxpZXJOYW1lT3V0Ym91bmQ6IHN0cmluZztcbiAgcGF5bWVudFN1bTogbnVtYmVyO1xuICBwYXltZW50U3VtT3V0Ym91bmQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRBY2NvdW50IHtcbiAgaW5kZXg6IG51bWJlcjtcbiAgYWNjb3VudE51bWJlcjogc3RyaW5nO1xuICBwcm9jZXNzZWREYXRlOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBTY3JhcGVkTG9naW5WYWxpZGF0aW9uIHtcbiAgSGVhZGVyOiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIFZhbGlkYXRlSWREYXRhQmVhbj86IHtcbiAgICB1c2VyTmFtZT86IHN0cmluZztcbiAgICByZXR1cm5Db2RlOiBzdHJpbmc7XG4gIH07XG59XG5cbmludGVyZmFjZSBTY3JhcGVkQWNjb3VudHNXaXRoaW5QYWdlUmVzcG9uc2Uge1xuICBIZWFkZXI6IHtcbiAgICBTdGF0dXM6IHN0cmluZztcbiAgfTtcbiAgRGFzaGJvYXJkTW9udGhCZWFuPzoge1xuICAgIGNhcmRzQ2hhcmdlczoge1xuICAgICAgY2FyZEluZGV4OiBzdHJpbmc7XG4gICAgICBjYXJkTnVtYmVyOiBzdHJpbmc7XG4gICAgICBiaWxsaW5nRGF0ZTogc3RyaW5nO1xuICAgIH1bXTtcbiAgfTtcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9ucyB7XG4gIHR4bklzcmFlbD86IFNjcmFwZWRUcmFuc2FjdGlvbltdO1xuICB0eG5BYnJvYWQ/OiBTY3JhcGVkVHJhbnNhY3Rpb25bXTtcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRUcmFuc2FjdGlvbkRhdGEge1xuICBIZWFkZXI/OiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIFBpcnRleUlza2FfMjA0QmVhbj86IHtcbiAgICBzZWN0b3I6IHN0cmluZztcbiAgfTtcblxuICBDYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuPzogUmVjb3JkPFxuICAgIHN0cmluZyxcbiAgICB7XG4gICAgICBDdXJyZW50Q2FyZFRyYW5zYWN0aW9uczogU2NyYXBlZEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zW107XG4gICAgfVxuICA+O1xufVxuXG5mdW5jdGlvbiBnZXRBY2NvdW50c1VybChzZXJ2aWNlc1VybDogc3RyaW5nLCBtb250aE1vbWVudDogTW9tZW50KSB7XG4gIGNvbnN0IGJpbGxpbmdEYXRlID0gbW9udGhNb21lbnQuZm9ybWF0KCdZWVlZLU1NLUREJyk7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdEYXNoYm9hcmRNb250aCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnYWN0aW9uQ29kZScsICcwJyk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdiaWxsaW5nRGF0ZScsIGJpbGxpbmdEYXRlKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2Zvcm1hdCcsICdKc29uJyk7XG4gIHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBY2NvdW50cyhwYWdlOiBQYWdlLCBzZXJ2aWNlc1VybDogc3RyaW5nLCBtb250aE1vbWVudDogTW9tZW50KTogUHJvbWlzZTxTY3JhcGVkQWNjb3VudFtdPiB7XG4gIGNvbnN0IGRhdGFVcmwgPSBnZXRBY2NvdW50c1VybChzZXJ2aWNlc1VybCwgbW9udGhNb21lbnQpO1xuICBkZWJ1ZyhgZmV0Y2hpbmcgYWNjb3VudHMgZnJvbSAke2RhdGFVcmx9YCk7XG4gIGNvbnN0IGRhdGFSZXN1bHQgPSBhd2FpdCBmZXRjaEdldFdpdGhpblBhZ2U8U2NyYXBlZEFjY291bnRzV2l0aGluUGFnZVJlc3BvbnNlPihwYWdlLCBkYXRhVXJsKTtcbiAgaWYgKGRhdGFSZXN1bHQgJiYgXy5nZXQoZGF0YVJlc3VsdCwgJ0hlYWRlci5TdGF0dXMnKSA9PT0gJzEnICYmIGRhdGFSZXN1bHQuRGFzaGJvYXJkTW9udGhCZWFuKSB7XG4gICAgY29uc3QgeyBjYXJkc0NoYXJnZXMgfSA9IGRhdGFSZXN1bHQuRGFzaGJvYXJkTW9udGhCZWFuO1xuICAgIGlmIChjYXJkc0NoYXJnZXMpIHtcbiAgICAgIHJldHVybiBjYXJkc0NoYXJnZXMubWFwKGNhcmRDaGFyZ2UgPT4ge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGluZGV4OiBwYXJzZUludChjYXJkQ2hhcmdlLmNhcmRJbmRleCwgMTApLFxuICAgICAgICAgIGFjY291bnROdW1iZXI6IGNhcmRDaGFyZ2UuY2FyZE51bWJlcixcbiAgICAgICAgICBwcm9jZXNzZWREYXRlOiBtb21lbnQoY2FyZENoYXJnZS5iaWxsaW5nRGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvbnNVcmwoc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCkge1xuICBjb25zdCBtb250aCA9IG1vbnRoTW9tZW50Lm1vbnRoKCkgKyAxO1xuICBjb25zdCB5ZWFyID0gbW9udGhNb21lbnQueWVhcigpO1xuICBjb25zdCBtb250aFN0ciA9IG1vbnRoIDwgMTAgPyBgMCR7bW9udGh9YCA6IG1vbnRoLnRvU3RyaW5nKCk7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdDYXJkc1RyYW5zYWN0aW9uc0xpc3QnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ21vbnRoJywgbW9udGhTdHIpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgneWVhcicsIGAke3llYXJ9YCk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdyZXF1aXJlZERhdGUnLCAnTicpO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRDdXJyZW5jeShjdXJyZW5jeVN0cjogc3RyaW5nKSB7XG4gIGlmIChjdXJyZW5jeVN0ciA9PT0gU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfHwgY3VycmVuY3lTdHIgPT09IEFMVF9TSEVLRUxfQ1VSUkVOQ1kpIHtcbiAgICByZXR1cm4gU0hFS0VMX0NVUlJFTkNZO1xuICB9XG4gIHJldHVybiBjdXJyZW5jeVN0cjtcbn1cblxuZnVuY3Rpb24gZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG46IFNjcmFwZWRUcmFuc2FjdGlvbik6IFRyYW5zYWN0aW9uSW5zdGFsbG1lbnRzIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0eG4ubW9yZUluZm8gfHwgIXR4bi5tb3JlSW5mby5pbmNsdWRlcyhJTlNUQUxMTUVOVFNfS0VZV09SRCkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IG1hdGNoZXMgPSB0eG4ubW9yZUluZm8ubWF0Y2goL1xcZCsvZyk7XG4gIGlmICghbWF0Y2hlcyB8fCBtYXRjaGVzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBudW1iZXI6IHBhcnNlSW50KG1hdGNoZXNbMF0sIDEwKSxcbiAgICB0b3RhbDogcGFyc2VJbnQobWF0Y2hlc1sxXSwgMTApLFxuICB9O1xufVxuXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvblR5cGUodHhuOiBTY3JhcGVkVHJhbnNhY3Rpb24pIHtcbiAgcmV0dXJuIGdldEluc3RhbGxtZW50c0luZm8odHhuKSA/IFRyYW5zYWN0aW9uVHlwZXMuSW5zdGFsbG1lbnRzIDogVHJhbnNhY3Rpb25UeXBlcy5Ob3JtYWw7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRUcmFuc2FjdGlvbnMoXG4gIHR4bnM6IFNjcmFwZWRUcmFuc2FjdGlvbltdLFxuICBwcm9jZXNzZWREYXRlOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiBTY3JhcGVyT3B0aW9ucyxcbik6IFRyYW5zYWN0aW9uW10ge1xuICBjb25zdCBmaWx0ZXJlZFR4bnMgPSB0eG5zLmZpbHRlcihcbiAgICB0eG4gPT5cbiAgICAgIHR4bi5kZWFsU3VtVHlwZSAhPT0gJzEnICYmIHR4bi52b3VjaGVyTnVtYmVyUmF0eiAhPT0gJzAwMDAwMDAwMCcgJiYgdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgIT09ICcwMDAwMDAwMDAnLFxuICApO1xuXG4gIHJldHVybiBmaWx0ZXJlZFR4bnMubWFwKHR4biA9PiB7XG4gICAgY29uc3QgaXNPdXRib3VuZCA9IHR4bi5kZWFsU3VtT3V0Ym91bmQ7XG4gICAgY29uc3QgdHhuRGF0ZVN0ciA9IGlzT3V0Ym91bmQgPyB0eG4uZnVsbFB1cmNoYXNlRGF0ZU91dGJvdW5kIDogdHhuLmZ1bGxQdXJjaGFzZURhdGU7XG4gICAgY29uc3QgdHhuTW9tZW50ID0gbW9tZW50KHR4bkRhdGVTdHIsIERBVEVfRk9STUFUKTtcblxuICAgIGNvbnN0IGN1cnJlbnRQcm9jZXNzZWREYXRlID0gdHhuLmZ1bGxQYXltZW50RGF0ZVxuICAgICAgPyBtb21lbnQodHhuLmZ1bGxQYXltZW50RGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKClcbiAgICAgIDogcHJvY2Vzc2VkRGF0ZTtcbiAgICBjb25zdCByZXN1bHQ6IFRyYW5zYWN0aW9uID0ge1xuICAgICAgdHlwZTogZ2V0VHJhbnNhY3Rpb25UeXBlKHR4biksXG4gICAgICBpZGVudGlmaWVyOiBwYXJzZUludChpc091dGJvdW5kID8gdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgOiB0eG4udm91Y2hlck51bWJlclJhdHosIDEwKSxcbiAgICAgIGRhdGU6IHR4bk1vbWVudC50b0lTT1N0cmluZygpLFxuICAgICAgcHJvY2Vzc2VkRGF0ZTogY3VycmVudFByb2Nlc3NlZERhdGUsXG4gICAgICBvcmlnaW5hbEFtb3VudDogaXNPdXRib3VuZCA/IC10eG4uZGVhbFN1bU91dGJvdW5kIDogLXR4bi5kZWFsU3VtLFxuICAgICAgb3JpZ2luYWxDdXJyZW5jeTogY29udmVydEN1cnJlbmN5KHR4bi5jdXJyZW50UGF5bWVudEN1cnJlbmN5ID8/IHR4bi5jdXJyZW5jeUlkKSxcbiAgICAgIGNoYXJnZWRBbW91bnQ6IGlzT3V0Ym91bmQgPyAtdHhuLnBheW1lbnRTdW1PdXRib3VuZCA6IC10eG4ucGF5bWVudFN1bSxcbiAgICAgIGNoYXJnZWRDdXJyZW5jeTogY29udmVydEN1cnJlbmN5KHR4bi5jdXJyZW5jeUlkKSxcbiAgICAgIGRlc2NyaXB0aW9uOiBpc091dGJvdW5kID8gdHhuLmZ1bGxTdXBwbGllck5hbWVPdXRib3VuZCA6IHR4bi5mdWxsU3VwcGxpZXJOYW1lSGViLFxuICAgICAgbWVtbzogdHhuLm1vcmVJbmZvIHx8ICcnLFxuICAgICAgaW5zdGFsbG1lbnRzOiBnZXRJbnN0YWxsbWVudHNJbmZvKHR4bikgfHwgdW5kZWZpbmVkLFxuICAgICAgc3RhdHVzOiBUcmFuc2FjdGlvblN0YXR1c2VzLkNvbXBsZXRlZCxcbiAgICB9O1xuXG4gICAgaWYgKG9wdGlvbnM/LmluY2x1ZGVSYXdUcmFuc2FjdGlvbikge1xuICAgICAgcmVzdWx0LnJhd1RyYW5zYWN0aW9uID0gZ2V0UmF3VHJhbnNhY3Rpb24odHhuKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hUcmFuc2FjdGlvbnMoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBjb21wYW55U2VydmljZU9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgc3RhcnRNb21lbnQ6IE1vbWVudCxcbiAgbW9udGhNb21lbnQ6IE1vbWVudCxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4PiB7XG4gIGNvbnN0IGFjY291bnRzID0gYXdhaXQgZmV0Y2hBY2NvdW50cyhwYWdlLCBjb21wYW55U2VydmljZU9wdGlvbnMuc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcbiAgY29uc3QgZGF0YVVybCA9IGdldFRyYW5zYWN0aW9uc1VybChjb21wYW55U2VydmljZU9wdGlvbnMuc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcbiAgYXdhaXQgc2xlZXAoUkFURV9MSU1JVC5TTEVFUF9CRVRXRUVOKTtcbiAgZGVidWcoYGZldGNoaW5nIHRyYW5zYWN0aW9ucyBmcm9tICR7ZGF0YVVybH0gZm9yIG1vbnRoICR7bW9udGhNb21lbnQuZm9ybWF0KCdZWVlZLU1NJyl9YCk7XG4gIGNvbnN0IGRhdGFSZXN1bHQgPSBhd2FpdCBmZXRjaEdldFdpdGhpblBhZ2U8U2NyYXBlZFRyYW5zYWN0aW9uRGF0YT4ocGFnZSwgZGF0YVVybCk7XG4gIGlmIChkYXRhUmVzdWx0ICYmIF8uZ2V0KGRhdGFSZXN1bHQsICdIZWFkZXIuU3RhdHVzJykgPT09ICcxJyAmJiBkYXRhUmVzdWx0LkNhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4pIHtcbiAgICBjb25zdCBhY2NvdW50VHhuczogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4ID0ge307XG4gICAgYWNjb3VudHMuZm9yRWFjaChhY2NvdW50ID0+IHtcbiAgICAgIGNvbnN0IHR4bkdyb3VwczogU2NyYXBlZEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zW10gfCB1bmRlZmluZWQgPSBfLmdldChcbiAgICAgICAgZGF0YVJlc3VsdCxcbiAgICAgICAgYENhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4uSW5kZXgke2FjY291bnQuaW5kZXh9LkN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zYCxcbiAgICAgICk7XG4gICAgICBpZiAodHhuR3JvdXBzKSB7XG4gICAgICAgIGxldCBhbGxUeG5zOiBUcmFuc2FjdGlvbltdID0gW107XG4gICAgICAgIHR4bkdyb3Vwcy5mb3JFYWNoKHR4bkdyb3VwID0+IHtcbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuSXNyYWVsKSB7XG4gICAgICAgICAgICBjb25zdCB0eG5zID0gY29udmVydFRyYW5zYWN0aW9ucyh0eG5Hcm91cC50eG5Jc3JhZWwsIGFjY291bnQucHJvY2Vzc2VkRGF0ZSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4udHhucyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0eG5Hcm91cC50eG5BYnJvYWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHR4bnMgPSBjb252ZXJ0VHJhbnNhY3Rpb25zKHR4bkdyb3VwLnR4bkFicm9hZCwgYWNjb3VudC5wcm9jZXNzZWREYXRlLCBvcHRpb25zKTtcbiAgICAgICAgICAgIGFsbFR4bnMucHVzaCguLi50eG5zKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmICghb3B0aW9ucy5jb21iaW5lSW5zdGFsbG1lbnRzKSB7XG4gICAgICAgICAgYWxsVHhucyA9IGZpeEluc3RhbGxtZW50cyhhbGxUeG5zKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0aW9ucy5vdXRwdXREYXRhPy5lbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUgPz8gdHJ1ZSkge1xuICAgICAgICAgIGFsbFR4bnMgPSBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMoYWxsVHhucywgc3RhcnRNb21lbnQsIG9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cyB8fCBmYWxzZSk7XG4gICAgICAgIH1cbiAgICAgICAgYWNjb3VudFR4bnNbYWNjb3VudC5hY2NvdW50TnVtYmVyXSA9IHtcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBhY2NvdW50LmFjY291bnROdW1iZXIsXG4gICAgICAgICAgaW5kZXg6IGFjY291bnQuaW5kZXgsXG4gICAgICAgICAgdHhuczogYWxsVHhucyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gYWNjb3VudFR4bnM7XG4gIH1cblxuICByZXR1cm4ge307XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBtb250aDogTW9tZW50LFxuICBhY2NvdW50SW5kZXg6IG51bWJlcixcbiAgdHJhbnNhY3Rpb246IFRyYW5zYWN0aW9uLFxuKTogUHJvbWlzZTxUcmFuc2FjdGlvbj4ge1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKG9wdGlvbnMuc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdQaXJ0ZXlJc2thXzIwNCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnQ2FyZEluZGV4JywgYWNjb3VudEluZGV4LnRvU3RyaW5nKCkpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnc2hvdmFyUmF0eicsIHRyYW5zYWN0aW9uLmlkZW50aWZpZXIhLnRvU3RyaW5nKCkpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnbW9lZENoaXV2JywgbW9udGguZm9ybWF0KCdNTVlZWVknKSk7XG5cbiAgZGVidWcoYGZldGNoaW5nIGV4dHJhIHNjcmFwIGZvciB0cmFuc2FjdGlvbiAke3RyYW5zYWN0aW9uLmlkZW50aWZpZXJ9IGZvciBtb250aCAke21vbnRoLmZvcm1hdCgnWVlZWS1NTScpfWApO1xuICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRUcmFuc2FjdGlvbkRhdGE+KHBhZ2UsIHVybC50b1N0cmluZygpKTtcbiAgaWYgKCFkYXRhKSB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uO1xuICB9XG5cbiAgY29uc3QgcmF3Q2F0ZWdvcnkgPSBfLmdldChkYXRhLCAnUGlydGV5SXNrYV8yMDRCZWFuLnNlY3RvcicpID8/ICcnO1xuICByZXR1cm4ge1xuICAgIC4uLnRyYW5zYWN0aW9uLFxuICAgIGNhdGVnb3J5OiByYXdDYXRlZ29yeS50cmltKCksXG4gICAgcmF3VHJhbnNhY3Rpb246IGdldFJhd1RyYW5zYWN0aW9uKGRhdGEsIHRyYW5zYWN0aW9uKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RXh0cmFTY3JhcEFjY291bnQoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgYWNjb3VudE1hcDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4LFxuICBtb250aDogbW9tZW50Lk1vbWVudCxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4PiB7XG4gIGNvbnN0IGFjY291bnRzOiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXhbc3RyaW5nXVtdID0gW107XG4gIGZvciAoY29uc3QgYWNjb3VudCBvZiBPYmplY3QudmFsdWVzKGFjY291bnRNYXApKSB7XG4gICAgZGVidWcoXG4gICAgICBgZ2V0IGV4dHJhIHNjcmFwIGZvciAke2FjY291bnQuYWNjb3VudE51bWJlcn0gd2l0aCAke2FjY291bnQudHhucy5sZW5ndGh9IHRyYW5zYWN0aW9uc2AsXG4gICAgICBtb250aC5mb3JtYXQoJ1lZWVktTU0nKSxcbiAgICApO1xuICAgIGNvbnN0IHR4bnM6IFRyYW5zYWN0aW9uW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHR4bnNDaHVuayBvZiBfLmNodW5rKGFjY291bnQudHhucywgUkFURV9MSU1JVC5UUkFOU0FDVElPTlNfQkFUQ0hfU0laRSkpIHtcbiAgICAgIGRlYnVnKGBwcm9jZXNzaW5nIGNodW5rIG9mICR7dHhuc0NodW5rLmxlbmd0aH0gdHJhbnNhY3Rpb25zIGZvciBhY2NvdW50ICR7YWNjb3VudC5hY2NvdW50TnVtYmVyfWApO1xuICAgICAgY29uc3QgdXBkYXRlZFR4bnMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgdHhuc0NodW5rLm1hcCh0ID0+IGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihwYWdlLCBvcHRpb25zLCBtb250aCwgYWNjb3VudC5pbmRleCwgdCkpLFxuICAgICAgKTtcbiAgICAgIGF3YWl0IHNsZWVwKFJBVEVfTElNSVQuU0xFRVBfQkVUV0VFTik7XG4gICAgICB0eG5zLnB1c2goLi4udXBkYXRlZFR4bnMpO1xuICAgIH1cbiAgICBhY2NvdW50cy5wdXNoKHsgLi4uYWNjb3VudCwgdHhucyB9KTtcbiAgfVxuXG4gIHJldHVybiBhY2NvdW50cy5yZWR1Y2UoKG0sIHgpID0+ICh7IC4uLm0sIFt4LmFjY291bnROdW1iZXJdOiB4IH0pLCB7fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uKFxuICBzY3JhcGVyT3B0aW9uczogU2NyYXBlck9wdGlvbnMsXG4gIGFjY291bnRzV2l0aEluZGV4OiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXhbXSxcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBhbGxNb250aHM6IG1vbWVudC5Nb21lbnRbXSxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10+IHtcbiAgaWYgKFxuICAgICFzY3JhcGVyT3B0aW9ucy5hZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbiB8fFxuICAgIHNjcmFwZXJPcHRpb25zLm9wdEluRmVhdHVyZXM/LmluY2x1ZGVzKCdpc3JhY2FyZC1hbWV4OnNraXBBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbicpXG4gICkge1xuICAgIHJldHVybiBhY2NvdW50c1dpdGhJbmRleDtcbiAgfVxuICByZXR1cm4gcnVuU2VyaWFsKGFjY291bnRzV2l0aEluZGV4Lm1hcCgoYSwgaSkgPT4gKCkgPT4gZ2V0RXh0cmFTY3JhcEFjY291bnQocGFnZSwgb3B0aW9ucywgYSwgYWxsTW9udGhzW2ldKSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFsbFRyYW5zYWN0aW9ucyhcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogU2NyYXBlck9wdGlvbnMsXG4gIGNvbXBhbnlTZXJ2aWNlT3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBzdGFydE1vbWVudDogTW9tZW50LFxuKSB7XG4gIGNvbnN0IGZ1dHVyZU1vbnRoc1RvU2NyYXBlID0gb3B0aW9ucy5mdXR1cmVNb250aHNUb1NjcmFwZSA/PyAxO1xuICBjb25zdCBhbGxNb250aHMgPSBnZXRBbGxNb250aE1vbWVudHMoc3RhcnRNb21lbnQsIGZ1dHVyZU1vbnRoc1RvU2NyYXBlKTtcbiAgY29uc3QgcmVzdWx0czogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10gPSBhd2FpdCBydW5TZXJpYWwoXG4gICAgYWxsTW9udGhzLm1hcChtb250aE1vbWVudCA9PiAoKSA9PiB7XG4gICAgICByZXR1cm4gZmV0Y2hUcmFuc2FjdGlvbnMocGFnZSwgb3B0aW9ucywgY29tcGFueVNlcnZpY2VPcHRpb25zLCBzdGFydE1vbWVudCwgbW9udGhNb21lbnQpO1xuICAgIH0pLFxuICApO1xuXG4gIGNvbnN0IGZpbmFsUmVzdWx0ID0gYXdhaXQgZ2V0QWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24oXG4gICAgb3B0aW9ucyxcbiAgICByZXN1bHRzLFxuICAgIHBhZ2UsXG4gICAgY29tcGFueVNlcnZpY2VPcHRpb25zLFxuICAgIGFsbE1vbnRocyxcbiAgKTtcbiAgY29uc3QgY29tYmluZWRUeG5zOiBSZWNvcmQ8c3RyaW5nLCBUcmFuc2FjdGlvbltdPiA9IHt9O1xuXG4gIGZpbmFsUmVzdWx0LmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICBPYmplY3Qua2V5cyhyZXN1bHQpLmZvckVhY2goYWNjb3VudE51bWJlciA9PiB7XG4gICAgICBsZXQgdHhuc0ZvckFjY291bnQgPSBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl07XG4gICAgICBpZiAoIXR4bnNGb3JBY2NvdW50KSB7XG4gICAgICAgIHR4bnNGb3JBY2NvdW50ID0gW107XG4gICAgICAgIGNvbWJpbmVkVHhuc1thY2NvdW50TnVtYmVyXSA9IHR4bnNGb3JBY2NvdW50O1xuICAgICAgfVxuICAgICAgY29uc3QgdG9CZUFkZGVkVHhucyA9IHJlc3VsdFthY2NvdW50TnVtYmVyXS50eG5zO1xuICAgICAgY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdLnB1c2goLi4udG9CZUFkZGVkVHhucyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGNvbnN0IGFjY291bnRzID0gT2JqZWN0LmtleXMoY29tYmluZWRUeG5zKS5tYXAoYWNjb3VudE51bWJlciA9PiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjY291bnROdW1iZXIsXG4gICAgICB0eG5zOiBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0sXG4gICAgfTtcbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGFjY291bnRzLFxuICB9O1xufVxuXG50eXBlIFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzID0geyBpZDogc3RyaW5nOyBwYXNzd29yZDogc3RyaW5nOyBjYXJkNkRpZ2l0czogc3RyaW5nIH07XG5jbGFzcyBJc3JhY2FyZEFtZXhCYXNlU2NyYXBlciBleHRlbmRzIEJhc2VTY3JhcGVyV2l0aEJyb3dzZXI8U2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHM+IHtcbiAgcHJpdmF0ZSBiYXNlVXJsOiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSBjb21wYW55Q29kZTogc3RyaW5nO1xuXG4gIHByaXZhdGUgc2VydmljZXNVcmw6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBTY3JhcGVyT3B0aW9ucywgYmFzZVVybDogc3RyaW5nLCBjb21wYW55Q29kZTogc3RyaW5nKSB7XG4gICAgc3VwZXIob3B0aW9ucyk7XG5cbiAgICB0aGlzLmJhc2VVcmwgPSBiYXNlVXJsO1xuICAgIHRoaXMuY29tcGFueUNvZGUgPSBjb21wYW55Q29kZTtcbiAgICB0aGlzLnNlcnZpY2VzVXJsID0gYCR7YmFzZVVybH0vc2VydmljZXMvUHJveHlSZXF1ZXN0SGFuZGxlci5hc2h4YDtcbiAgfVxuXG4gIGFzeW5jIGxvZ2luKGNyZWRlbnRpYWxzOiBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyk6IFByb21pc2U8U2NyYXBlclNjcmFwaW5nUmVzdWx0PiB7XG4gICAgYXdhaXQgbWFza0hlYWRsZXNzVXNlckFnZW50KHRoaXMucGFnZSk7XG5cbiAgICBhd2FpdCB0aGlzLnBhZ2Uuc2V0UmVxdWVzdEludGVyY2VwdGlvbih0cnVlKTtcbiAgICB0aGlzLnBhZ2Uub24oJ3JlcXVlc3QnLCByZXF1ZXN0ID0+IHtcbiAgICAgIGlmIChyZXF1ZXN0LnVybCgpLmluY2x1ZGVzKCdkZXRlY3Rvci1kb20ubWluLmpzJykpIHtcbiAgICAgICAgZGVidWcoJ2ZvcmNlIGFib3J0IGZvciByZXF1ZXN0IGRvIGRvd25sb2FkIGRldGVjdG9yLWRvbS5taW4uanMgcmVzb3VyY2UnKTtcbiAgICAgICAgdm9pZCByZXF1ZXN0LmFib3J0KHVuZGVmaW5lZCwgaW50ZXJjZXB0aW9uUHJpb3JpdGllcy5hYm9ydCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2b2lkIHJlcXVlc3QuY29udGludWUodW5kZWZpbmVkLCBpbnRlcmNlcHRpb25Qcmlvcml0aWVzLmNvbnRpbnVlKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIE5hdmlnYXRlIHRvIGhvbWVwYWdlIGZpcnN0IHRvIGVzdGFibGlzaCBzZXNzaW9uXG4gICAgZGVidWcoJ3dhcm1pbmcgdXAgYnJvd3NlciB3aXRoIGhvbWVwYWdlJyk7XG4gICAgYXdhaXQgdGhpcy5uYXZpZ2F0ZVRvKHRoaXMuYmFzZVVybCwgJ2RvbWNvbnRlbnRsb2FkZWQnKTtcbiAgICBhd2FpdCBzbGVlcCgxMDAwKTtcblxuICAgIGRlYnVnKCduYXZpZ2F0aW5nIHRvIGxvZ2luIHBhZ2UnKTtcbiAgICBhd2FpdCB0aGlzLm5hdmlnYXRlVG8oYCR7dGhpcy5iYXNlVXJsfS9wZXJzb25hbGFyZWEvTG9naW5gKTtcblxuICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2dpbmdJbik7XG5cbiAgICBjb25zdCB2YWxpZGF0ZVVybCA9IGAke3RoaXMuc2VydmljZXNVcmx9P3JlcU5hbWU9VmFsaWRhdGVJZERhdGFgO1xuICAgIGNvbnN0IHZhbGlkYXRlUmVxdWVzdCA9IHtcbiAgICAgIGlkOiBjcmVkZW50aWFscy5pZCxcbiAgICAgIGNhcmRTdWZmaXg6IGNyZWRlbnRpYWxzLmNhcmQ2RGlnaXRzLFxuICAgICAgY291bnRyeUNvZGU6IENPVU5UUllfQ09ERSxcbiAgICAgIGlkVHlwZTogSURfVFlQRSxcbiAgICAgIGNoZWNrTGV2ZWw6ICcxJyxcbiAgICAgIGNvbXBhbnlDb2RlOiB0aGlzLmNvbXBhbnlDb2RlLFxuICAgIH07XG4gICAgZGVidWcoJ2xvZ2dpbmcgaW4gd2l0aCB2YWxpZGF0ZSByZXF1ZXN0Jyk7XG4gICAgY29uc3QgdmFsaWRhdGVSZXN1bHQgPSBhd2FpdCBmZXRjaFBvc3RXaXRoaW5QYWdlPFNjcmFwZWRMb2dpblZhbGlkYXRpb24+KHRoaXMucGFnZSwgdmFsaWRhdGVVcmwsIHZhbGlkYXRlUmVxdWVzdCk7XG4gICAgaWYgKFxuICAgICAgIXZhbGlkYXRlUmVzdWx0IHx8XG4gICAgICAhdmFsaWRhdGVSZXN1bHQuSGVhZGVyIHx8XG4gICAgICB2YWxpZGF0ZVJlc3VsdC5IZWFkZXIuU3RhdHVzICE9PSAnMScgfHxcbiAgICAgICF2YWxpZGF0ZVJlc3VsdC5WYWxpZGF0ZUlkRGF0YUJlYW5cbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcigndW5rbm93biBlcnJvciBkdXJpbmcgbG9naW4nKTtcbiAgICB9XG5cbiAgICBjb25zdCB2YWxpZGF0ZVJldHVybkNvZGUgPSB2YWxpZGF0ZVJlc3VsdC5WYWxpZGF0ZUlkRGF0YUJlYW4ucmV0dXJuQ29kZTtcbiAgICBkZWJ1ZyhgdXNlciB2YWxpZGF0ZSB3aXRoIHJldHVybiBjb2RlICcke3ZhbGlkYXRlUmV0dXJuQ29kZX0nYCk7XG4gICAgaWYgKHZhbGlkYXRlUmV0dXJuQ29kZSA9PT0gJzEnKSB7XG4gICAgICBjb25zdCB7IHVzZXJOYW1lIH0gPSB2YWxpZGF0ZVJlc3VsdC5WYWxpZGF0ZUlkRGF0YUJlYW47XG5cbiAgICAgIGNvbnN0IGxvZ2luVXJsID0gYCR7dGhpcy5zZXJ2aWNlc1VybH0/cmVxTmFtZT1wZXJmb3JtTG9nb25JYDtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSB7XG4gICAgICAgIEtvZE1pc2h0YW1lc2g6IHVzZXJOYW1lLFxuICAgICAgICBNaXNwYXJaaWh1eTogY3JlZGVudGlhbHMuaWQsXG4gICAgICAgIFNpc21hOiBjcmVkZW50aWFscy5wYXNzd29yZCxcbiAgICAgICAgY2FyZFN1ZmZpeDogY3JlZGVudGlhbHMuY2FyZDZEaWdpdHMsXG4gICAgICAgIGNvdW50cnlDb2RlOiBDT1VOVFJZX0NPREUsXG4gICAgICAgIGlkVHlwZTogSURfVFlQRSxcbiAgICAgIH07XG4gICAgICBkZWJ1ZygndXNlciBsb2dpbiBzdGFydGVkJyk7XG4gICAgICBjb25zdCBsb2dpblJlc3VsdCA9IGF3YWl0IGZldGNoUG9zdFdpdGhpblBhZ2U8eyBzdGF0dXM6IHN0cmluZyB9Pih0aGlzLnBhZ2UsIGxvZ2luVXJsLCByZXF1ZXN0KTtcbiAgICAgIGRlYnVnKGB1c2VyIGxvZ2luIHdpdGggc3RhdHVzICcke2xvZ2luUmVzdWx0Py5zdGF0dXN9J2AsIGxvZ2luUmVzdWx0KTtcblxuICAgICAgaWYgKGxvZ2luUmVzdWx0ICYmIGxvZ2luUmVzdWx0LnN0YXR1cyA9PT0gJzEnKSB7XG4gICAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2luU3VjY2Vzcyk7XG4gICAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUgfTtcbiAgICAgIH1cblxuICAgICAgaWYgKGxvZ2luUmVzdWx0ICYmIGxvZ2luUmVzdWx0LnN0YXR1cyA9PT0gJzMnKSB7XG4gICAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkNoYW5nZVBhc3N3b3JkKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkNoYW5nZVBhc3N3b3JkLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dpbkZhaWxlZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5JbnZhbGlkUGFzc3dvcmQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmICh2YWxpZGF0ZVJldHVybkNvZGUgPT09ICc0Jykge1xuICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuQ2hhbmdlUGFzc3dvcmQpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuQ2hhbmdlUGFzc3dvcmQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2luRmFpbGVkKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkludmFsaWRQYXNzd29yZCxcbiAgICB9O1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hEYXRhKCkge1xuICAgIGNvbnN0IGRlZmF1bHRTdGFydE1vbWVudCA9IG1vbWVudCgpLnN1YnRyYWN0KDEsICd5ZWFycycpO1xuICAgIGNvbnN0IHN0YXJ0RGF0ZSA9IHRoaXMub3B0aW9ucy5zdGFydERhdGUgfHwgZGVmYXVsdFN0YXJ0TW9tZW50LnRvRGF0ZSgpO1xuICAgIGNvbnN0IHN0YXJ0TW9tZW50ID0gbW9tZW50Lm1heChkZWZhdWx0U3RhcnRNb21lbnQsIG1vbWVudChzdGFydERhdGUpKTtcblxuICAgIHJldHVybiBmZXRjaEFsbFRyYW5zYWN0aW9ucyhcbiAgICAgIHRoaXMucGFnZSxcbiAgICAgIHRoaXMub3B0aW9ucyxcbiAgICAgIHtcbiAgICAgICAgc2VydmljZXNVcmw6IHRoaXMuc2VydmljZXNVcmwsXG4gICAgICAgIGNvbXBhbnlDb2RlOiB0aGlzLmNvbXBhbnlDb2RlLFxuICAgICAgfSxcbiAgICAgIHN0YXJ0TW9tZW50LFxuICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgSXNyYWNhcmRBbWV4QmFzZVNjcmFw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