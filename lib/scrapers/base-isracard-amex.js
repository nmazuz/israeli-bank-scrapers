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
    await this.page.setRequestInterception(true);
    this.page.on('request', request => {
      if (request.url().includes('detector-dom.min.js')) {
        debug('force abort for request do download detector-dom.min.js resource');
        void request.abort(undefined, _browser.interceptionPriorities.abort);
      } else {
        void request.continue(undefined, _browser.interceptionPriorities.continue);
      }
    });
    await (0, _browser.maskHeadlessUserAgent)(this.page);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9kYXNoIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbW9tZW50IiwiX2NvbnN0YW50cyIsIl9kZWZpbml0aW9ucyIsIl9kYXRlcyIsIl9kZWJ1ZyIsIl9mZXRjaCIsIl90cmFuc2FjdGlvbnMiLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMyIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXJyb3JzIiwiX2Jyb3dzZXIiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJSQVRFX0xJTUlUIiwiU0xFRVBfQkVUV0VFTiIsIlRSQU5TQUNUSU9OU19CQVRDSF9TSVpFIiwiQ09VTlRSWV9DT0RFIiwiSURfVFlQRSIsIklOU1RBTExNRU5UU19LRVlXT1JEIiwiREFURV9GT1JNQVQiLCJkZWJ1ZyIsImdldERlYnVnIiwiZ2V0QWNjb3VudHNVcmwiLCJzZXJ2aWNlc1VybCIsIm1vbnRoTW9tZW50IiwiYmlsbGluZ0RhdGUiLCJmb3JtYXQiLCJ1cmwiLCJVUkwiLCJzZWFyY2hQYXJhbXMiLCJzZXQiLCJ0b1N0cmluZyIsImZldGNoQWNjb3VudHMiLCJwYWdlIiwiZGF0YVVybCIsImRhdGFSZXN1bHQiLCJmZXRjaEdldFdpdGhpblBhZ2UiLCJfIiwiZ2V0IiwiRGFzaGJvYXJkTW9udGhCZWFuIiwiY2FyZHNDaGFyZ2VzIiwibWFwIiwiY2FyZENoYXJnZSIsImluZGV4IiwicGFyc2VJbnQiLCJjYXJkSW5kZXgiLCJhY2NvdW50TnVtYmVyIiwiY2FyZE51bWJlciIsInByb2Nlc3NlZERhdGUiLCJtb21lbnQiLCJ0b0lTT1N0cmluZyIsImdldFRyYW5zYWN0aW9uc1VybCIsIm1vbnRoIiwieWVhciIsIm1vbnRoU3RyIiwiY29udmVydEN1cnJlbmN5IiwiY3VycmVuY3lTdHIiLCJTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCIsIkFMVF9TSEVLRUxfQ1VSUkVOQ1kiLCJTSEVLRUxfQ1VSUkVOQ1kiLCJnZXRJbnN0YWxsbWVudHNJbmZvIiwidHhuIiwibW9yZUluZm8iLCJpbmNsdWRlcyIsInVuZGVmaW5lZCIsIm1hdGNoZXMiLCJtYXRjaCIsImxlbmd0aCIsIm51bWJlciIsInRvdGFsIiwiZ2V0VHJhbnNhY3Rpb25UeXBlIiwiVHJhbnNhY3Rpb25UeXBlcyIsIkluc3RhbGxtZW50cyIsIk5vcm1hbCIsImNvbnZlcnRUcmFuc2FjdGlvbnMiLCJ0eG5zIiwib3B0aW9ucyIsImZpbHRlcmVkVHhucyIsImZpbHRlciIsImRlYWxTdW1UeXBlIiwidm91Y2hlck51bWJlclJhdHoiLCJ2b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIiwiaXNPdXRib3VuZCIsImRlYWxTdW1PdXRib3VuZCIsInR4bkRhdGVTdHIiLCJmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQiLCJmdWxsUHVyY2hhc2VEYXRlIiwidHhuTW9tZW50IiwiY3VycmVudFByb2Nlc3NlZERhdGUiLCJmdWxsUGF5bWVudERhdGUiLCJyZXN1bHQiLCJ0eXBlIiwiaWRlbnRpZmllciIsImRhdGUiLCJvcmlnaW5hbEFtb3VudCIsImRlYWxTdW0iLCJvcmlnaW5hbEN1cnJlbmN5IiwiY3VycmVudFBheW1lbnRDdXJyZW5jeSIsImN1cnJlbmN5SWQiLCJjaGFyZ2VkQW1vdW50IiwicGF5bWVudFN1bU91dGJvdW5kIiwicGF5bWVudFN1bSIsImNoYXJnZWRDdXJyZW5jeSIsImRlc2NyaXB0aW9uIiwiZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIiwiZnVsbFN1cHBsaWVyTmFtZUhlYiIsIm1lbW8iLCJpbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiQ29tcGxldGVkIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsImZldGNoVHJhbnNhY3Rpb25zIiwiY29tcGFueVNlcnZpY2VPcHRpb25zIiwic3RhcnRNb21lbnQiLCJhY2NvdW50cyIsInNsZWVwIiwiQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbiIsImFjY291bnRUeG5zIiwiZm9yRWFjaCIsImFjY291bnQiLCJ0eG5Hcm91cHMiLCJhbGxUeG5zIiwidHhuR3JvdXAiLCJ0eG5Jc3JhZWwiLCJwdXNoIiwidHhuQWJyb2FkIiwiY29tYmluZUluc3RhbGxtZW50cyIsImZpeEluc3RhbGxtZW50cyIsIm91dHB1dERhdGEiLCJlbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUiLCJmaWx0ZXJPbGRUcmFuc2FjdGlvbnMiLCJnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24iLCJhY2NvdW50SW5kZXgiLCJ0cmFuc2FjdGlvbiIsImRhdGEiLCJyYXdDYXRlZ29yeSIsImNhdGVnb3J5IiwidHJpbSIsImdldEV4dHJhU2NyYXBBY2NvdW50IiwiYWNjb3VudE1hcCIsIk9iamVjdCIsInZhbHVlcyIsInR4bnNDaHVuayIsImNodW5rIiwidXBkYXRlZFR4bnMiLCJQcm9taXNlIiwiYWxsIiwidCIsInJlZHVjZSIsIm0iLCJ4IiwiZ2V0QWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJzY3JhcGVyT3B0aW9ucyIsImFjY291bnRzV2l0aEluZGV4IiwiYWxsTW9udGhzIiwiYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJvcHRJbkZlYXR1cmVzIiwicnVuU2VyaWFsIiwiYSIsImkiLCJmZXRjaEFsbFRyYW5zYWN0aW9ucyIsImZ1dHVyZU1vbnRoc1RvU2NyYXBlIiwiZ2V0QWxsTW9udGhNb21lbnRzIiwicmVzdWx0cyIsImZpbmFsUmVzdWx0IiwiY29tYmluZWRUeG5zIiwia2V5cyIsInR4bnNGb3JBY2NvdW50IiwidG9CZUFkZGVkVHhucyIsInN1Y2Nlc3MiLCJJc3JhY2FyZEFtZXhCYXNlU2NyYXBlciIsIkJhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJjb25zdHJ1Y3RvciIsImJhc2VVcmwiLCJjb21wYW55Q29kZSIsImxvZ2luIiwiY3JlZGVudGlhbHMiLCJzZXRSZXF1ZXN0SW50ZXJjZXB0aW9uIiwib24iLCJyZXF1ZXN0IiwiYWJvcnQiLCJpbnRlcmNlcHRpb25Qcmlvcml0aWVzIiwiY29udGludWUiLCJtYXNrSGVhZGxlc3NVc2VyQWdlbnQiLCJuYXZpZ2F0ZVRvIiwiZW1pdFByb2dyZXNzIiwiU2NyYXBlclByb2dyZXNzVHlwZXMiLCJMb2dnaW5nSW4iLCJ2YWxpZGF0ZVVybCIsInZhbGlkYXRlUmVxdWVzdCIsImlkIiwiY2FyZFN1ZmZpeCIsImNhcmQ2RGlnaXRzIiwiY291bnRyeUNvZGUiLCJpZFR5cGUiLCJjaGVja0xldmVsIiwidmFsaWRhdGVSZXN1bHQiLCJmZXRjaFBvc3RXaXRoaW5QYWdlIiwiSGVhZGVyIiwiU3RhdHVzIiwiVmFsaWRhdGVJZERhdGFCZWFuIiwiRXJyb3IiLCJ2YWxpZGF0ZVJldHVybkNvZGUiLCJyZXR1cm5Db2RlIiwidXNlck5hbWUiLCJsb2dpblVybCIsIktvZE1pc2h0YW1lc2giLCJNaXNwYXJaaWh1eSIsIlNpc21hIiwicGFzc3dvcmQiLCJsb2dpblJlc3VsdCIsIkxvZ2luU3VjY2VzcyIsIkNoYW5nZVBhc3N3b3JkIiwiZXJyb3JUeXBlIiwiU2NyYXBlckVycm9yVHlwZXMiLCJMb2dpbkZhaWxlZCIsIkludmFsaWRQYXNzd29yZCIsImZldGNoRGF0YSIsImRlZmF1bHRTdGFydE1vbWVudCIsInN1YnRyYWN0Iiwic3RhcnREYXRlIiwidG9EYXRlIiwibWF4IiwiX2RlZmF1bHQiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL3NjcmFwZXJzL2Jhc2UtaXNyYWNhcmQtYW1leC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IG1vbWVudCwgeyB0eXBlIE1vbWVudCB9IGZyb20gJ21vbWVudCc7XG5pbXBvcnQgeyB0eXBlIFBhZ2UgfSBmcm9tICdwdXBwZXRlZXInO1xuaW1wb3J0IHsgQUxUX1NIRUtFTF9DVVJSRU5DWSwgU0hFS0VMX0NVUlJFTkNZLCBTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCB9IGZyb20gJy4uL2NvbnN0YW50cyc7XG5pbXBvcnQgeyBTY3JhcGVyUHJvZ3Jlc3NUeXBlcyB9IGZyb20gJy4uL2RlZmluaXRpb25zJztcbmltcG9ydCBnZXRBbGxNb250aE1vbWVudHMgZnJvbSAnLi4vaGVscGVycy9kYXRlcyc7XG5pbXBvcnQgeyBnZXREZWJ1ZyB9IGZyb20gJy4uL2hlbHBlcnMvZGVidWcnO1xuaW1wb3J0IHsgZmV0Y2hHZXRXaXRoaW5QYWdlLCBmZXRjaFBvc3RXaXRoaW5QYWdlIH0gZnJvbSAnLi4vaGVscGVycy9mZXRjaCc7XG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGZpeEluc3RhbGxtZW50cywgZ2V0UmF3VHJhbnNhY3Rpb24gfSBmcm9tICcuLi9oZWxwZXJzL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBydW5TZXJpYWwsIHNsZWVwIH0gZnJvbSAnLi4vaGVscGVycy93YWl0aW5nJztcbmltcG9ydCB7XG4gIFRyYW5zYWN0aW9uU3RhdHVzZXMsXG4gIFRyYW5zYWN0aW9uVHlwZXMsXG4gIHR5cGUgVHJhbnNhY3Rpb24sXG4gIHR5cGUgVHJhbnNhY3Rpb25JbnN0YWxsbWVudHMsXG4gIHR5cGUgVHJhbnNhY3Rpb25zQWNjb3VudCxcbn0gZnJvbSAnLi4vdHJhbnNhY3Rpb25zJztcbmltcG9ydCB7IEJhc2VTY3JhcGVyV2l0aEJyb3dzZXIgfSBmcm9tICcuL2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXInO1xuaW1wb3J0IHsgU2NyYXBlckVycm9yVHlwZXMgfSBmcm9tICcuL2Vycm9ycyc7XG5pbXBvcnQgeyB0eXBlIFNjcmFwZXJPcHRpb25zLCB0eXBlIFNjcmFwZXJTY3JhcGluZ1Jlc3VsdCB9IGZyb20gJy4vaW50ZXJmYWNlJztcbmltcG9ydCB7IGludGVyY2VwdGlvblByaW9yaXRpZXMsIG1hc2tIZWFkbGVzc1VzZXJBZ2VudCB9IGZyb20gJy4uL2hlbHBlcnMvYnJvd3Nlcic7XG5cbmNvbnN0IFJBVEVfTElNSVQgPSB7XG4gIFNMRUVQX0JFVFdFRU46IDEwMDAsXG4gIFRSQU5TQUNUSU9OU19CQVRDSF9TSVpFOiAxMCxcbn0gYXMgY29uc3Q7XG5cbmNvbnN0IENPVU5UUllfQ09ERSA9ICcyMTInO1xuY29uc3QgSURfVFlQRSA9ICcxJztcbmNvbnN0IElOU1RBTExNRU5UU19LRVlXT1JEID0gJ9eq16nXnNeV150nO1xuXG5jb25zdCBEQVRFX0ZPUk1BVCA9ICdERC9NTS9ZWVlZJztcblxuY29uc3QgZGVidWcgPSBnZXREZWJ1ZygnYmFzZS1pc3JhY2FyZC1hbWV4Jyk7XG5cbnR5cGUgQ29tcGFueVNlcnZpY2VPcHRpb25zID0ge1xuICBzZXJ2aWNlc1VybDogc3RyaW5nO1xuICBjb21wYW55Q29kZTogc3RyaW5nO1xufTtcblxudHlwZSBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXggPSBSZWNvcmQ8c3RyaW5nLCBUcmFuc2FjdGlvbnNBY2NvdW50ICYgeyBpbmRleDogbnVtYmVyIH0+O1xuXG5pbnRlcmZhY2UgU2NyYXBlZFRyYW5zYWN0aW9uIHtcbiAgZGVhbFN1bVR5cGU6IHN0cmluZztcbiAgdm91Y2hlck51bWJlclJhdHpPdXRib3VuZDogc3RyaW5nO1xuICB2b3VjaGVyTnVtYmVyUmF0ejogc3RyaW5nO1xuICBtb3JlSW5mbz86IHN0cmluZztcbiAgZGVhbFN1bU91dGJvdW5kOiBib29sZWFuO1xuICBjdXJyZW5jeUlkOiBzdHJpbmc7XG4gIGN1cnJlbnRQYXltZW50Q3VycmVuY3k6IHN0cmluZztcbiAgZGVhbFN1bTogbnVtYmVyO1xuICBmdWxsUGF5bWVudERhdGU/OiBzdHJpbmc7XG4gIGZ1bGxQdXJjaGFzZURhdGU/OiBzdHJpbmc7XG4gIGZ1bGxQdXJjaGFzZURhdGVPdXRib3VuZD86IHN0cmluZztcbiAgZnVsbFN1cHBsaWVyTmFtZUhlYjogc3RyaW5nO1xuICBmdWxsU3VwcGxpZXJOYW1lT3V0Ym91bmQ6IHN0cmluZztcbiAgcGF5bWVudFN1bTogbnVtYmVyO1xuICBwYXltZW50U3VtT3V0Ym91bmQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRBY2NvdW50IHtcbiAgaW5kZXg6IG51bWJlcjtcbiAgYWNjb3VudE51bWJlcjogc3RyaW5nO1xuICBwcm9jZXNzZWREYXRlOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBTY3JhcGVkTG9naW5WYWxpZGF0aW9uIHtcbiAgSGVhZGVyOiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIFZhbGlkYXRlSWREYXRhQmVhbj86IHtcbiAgICB1c2VyTmFtZT86IHN0cmluZztcbiAgICByZXR1cm5Db2RlOiBzdHJpbmc7XG4gIH07XG59XG5cbmludGVyZmFjZSBTY3JhcGVkQWNjb3VudHNXaXRoaW5QYWdlUmVzcG9uc2Uge1xuICBIZWFkZXI6IHtcbiAgICBTdGF0dXM6IHN0cmluZztcbiAgfTtcbiAgRGFzaGJvYXJkTW9udGhCZWFuPzoge1xuICAgIGNhcmRzQ2hhcmdlczoge1xuICAgICAgY2FyZEluZGV4OiBzdHJpbmc7XG4gICAgICBjYXJkTnVtYmVyOiBzdHJpbmc7XG4gICAgICBiaWxsaW5nRGF0ZTogc3RyaW5nO1xuICAgIH1bXTtcbiAgfTtcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9ucyB7XG4gIHR4bklzcmFlbD86IFNjcmFwZWRUcmFuc2FjdGlvbltdO1xuICB0eG5BYnJvYWQ/OiBTY3JhcGVkVHJhbnNhY3Rpb25bXTtcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRUcmFuc2FjdGlvbkRhdGEge1xuICBIZWFkZXI/OiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIFBpcnRleUlza2FfMjA0QmVhbj86IHtcbiAgICBzZWN0b3I6IHN0cmluZztcbiAgfTtcblxuICBDYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuPzogUmVjb3JkPFxuICAgIHN0cmluZyxcbiAgICB7XG4gICAgICBDdXJyZW50Q2FyZFRyYW5zYWN0aW9uczogU2NyYXBlZEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zW107XG4gICAgfVxuICA+O1xufVxuXG5mdW5jdGlvbiBnZXRBY2NvdW50c1VybChzZXJ2aWNlc1VybDogc3RyaW5nLCBtb250aE1vbWVudDogTW9tZW50KSB7XG4gIGNvbnN0IGJpbGxpbmdEYXRlID0gbW9udGhNb21lbnQuZm9ybWF0KCdZWVlZLU1NLUREJyk7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdEYXNoYm9hcmRNb250aCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnYWN0aW9uQ29kZScsICcwJyk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdiaWxsaW5nRGF0ZScsIGJpbGxpbmdEYXRlKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2Zvcm1hdCcsICdKc29uJyk7XG4gIHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBY2NvdW50cyhwYWdlOiBQYWdlLCBzZXJ2aWNlc1VybDogc3RyaW5nLCBtb250aE1vbWVudDogTW9tZW50KTogUHJvbWlzZTxTY3JhcGVkQWNjb3VudFtdPiB7XG4gIGNvbnN0IGRhdGFVcmwgPSBnZXRBY2NvdW50c1VybChzZXJ2aWNlc1VybCwgbW9udGhNb21lbnQpO1xuICBkZWJ1ZyhgZmV0Y2hpbmcgYWNjb3VudHMgZnJvbSAke2RhdGFVcmx9YCk7XG4gIGNvbnN0IGRhdGFSZXN1bHQgPSBhd2FpdCBmZXRjaEdldFdpdGhpblBhZ2U8U2NyYXBlZEFjY291bnRzV2l0aGluUGFnZVJlc3BvbnNlPihwYWdlLCBkYXRhVXJsKTtcbiAgaWYgKGRhdGFSZXN1bHQgJiYgXy5nZXQoZGF0YVJlc3VsdCwgJ0hlYWRlci5TdGF0dXMnKSA9PT0gJzEnICYmIGRhdGFSZXN1bHQuRGFzaGJvYXJkTW9udGhCZWFuKSB7XG4gICAgY29uc3QgeyBjYXJkc0NoYXJnZXMgfSA9IGRhdGFSZXN1bHQuRGFzaGJvYXJkTW9udGhCZWFuO1xuICAgIGlmIChjYXJkc0NoYXJnZXMpIHtcbiAgICAgIHJldHVybiBjYXJkc0NoYXJnZXMubWFwKGNhcmRDaGFyZ2UgPT4ge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGluZGV4OiBwYXJzZUludChjYXJkQ2hhcmdlLmNhcmRJbmRleCwgMTApLFxuICAgICAgICAgIGFjY291bnROdW1iZXI6IGNhcmRDaGFyZ2UuY2FyZE51bWJlcixcbiAgICAgICAgICBwcm9jZXNzZWREYXRlOiBtb21lbnQoY2FyZENoYXJnZS5iaWxsaW5nRGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvbnNVcmwoc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCkge1xuICBjb25zdCBtb250aCA9IG1vbnRoTW9tZW50Lm1vbnRoKCkgKyAxO1xuICBjb25zdCB5ZWFyID0gbW9udGhNb21lbnQueWVhcigpO1xuICBjb25zdCBtb250aFN0ciA9IG1vbnRoIDwgMTAgPyBgMCR7bW9udGh9YCA6IG1vbnRoLnRvU3RyaW5nKCk7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdDYXJkc1RyYW5zYWN0aW9uc0xpc3QnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ21vbnRoJywgbW9udGhTdHIpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgneWVhcicsIGAke3llYXJ9YCk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdyZXF1aXJlZERhdGUnLCAnTicpO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRDdXJyZW5jeShjdXJyZW5jeVN0cjogc3RyaW5nKSB7XG4gIGlmIChjdXJyZW5jeVN0ciA9PT0gU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfHwgY3VycmVuY3lTdHIgPT09IEFMVF9TSEVLRUxfQ1VSUkVOQ1kpIHtcbiAgICByZXR1cm4gU0hFS0VMX0NVUlJFTkNZO1xuICB9XG4gIHJldHVybiBjdXJyZW5jeVN0cjtcbn1cblxuZnVuY3Rpb24gZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG46IFNjcmFwZWRUcmFuc2FjdGlvbik6IFRyYW5zYWN0aW9uSW5zdGFsbG1lbnRzIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0eG4ubW9yZUluZm8gfHwgIXR4bi5tb3JlSW5mby5pbmNsdWRlcyhJTlNUQUxMTUVOVFNfS0VZV09SRCkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IG1hdGNoZXMgPSB0eG4ubW9yZUluZm8ubWF0Y2goL1xcZCsvZyk7XG4gIGlmICghbWF0Y2hlcyB8fCBtYXRjaGVzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBudW1iZXI6IHBhcnNlSW50KG1hdGNoZXNbMF0sIDEwKSxcbiAgICB0b3RhbDogcGFyc2VJbnQobWF0Y2hlc1sxXSwgMTApLFxuICB9O1xufVxuXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvblR5cGUodHhuOiBTY3JhcGVkVHJhbnNhY3Rpb24pIHtcbiAgcmV0dXJuIGdldEluc3RhbGxtZW50c0luZm8odHhuKSA/IFRyYW5zYWN0aW9uVHlwZXMuSW5zdGFsbG1lbnRzIDogVHJhbnNhY3Rpb25UeXBlcy5Ob3JtYWw7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRUcmFuc2FjdGlvbnMoXG4gIHR4bnM6IFNjcmFwZWRUcmFuc2FjdGlvbltdLFxuICBwcm9jZXNzZWREYXRlOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiBTY3JhcGVyT3B0aW9ucyxcbik6IFRyYW5zYWN0aW9uW10ge1xuICBjb25zdCBmaWx0ZXJlZFR4bnMgPSB0eG5zLmZpbHRlcihcbiAgICB0eG4gPT5cbiAgICAgIHR4bi5kZWFsU3VtVHlwZSAhPT0gJzEnICYmIHR4bi52b3VjaGVyTnVtYmVyUmF0eiAhPT0gJzAwMDAwMDAwMCcgJiYgdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgIT09ICcwMDAwMDAwMDAnLFxuICApO1xuXG4gIHJldHVybiBmaWx0ZXJlZFR4bnMubWFwKHR4biA9PiB7XG4gICAgY29uc3QgaXNPdXRib3VuZCA9IHR4bi5kZWFsU3VtT3V0Ym91bmQ7XG4gICAgY29uc3QgdHhuRGF0ZVN0ciA9IGlzT3V0Ym91bmQgPyB0eG4uZnVsbFB1cmNoYXNlRGF0ZU91dGJvdW5kIDogdHhuLmZ1bGxQdXJjaGFzZURhdGU7XG4gICAgY29uc3QgdHhuTW9tZW50ID0gbW9tZW50KHR4bkRhdGVTdHIsIERBVEVfRk9STUFUKTtcblxuICAgIGNvbnN0IGN1cnJlbnRQcm9jZXNzZWREYXRlID0gdHhuLmZ1bGxQYXltZW50RGF0ZVxuICAgICAgPyBtb21lbnQodHhuLmZ1bGxQYXltZW50RGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKClcbiAgICAgIDogcHJvY2Vzc2VkRGF0ZTtcbiAgICBjb25zdCByZXN1bHQ6IFRyYW5zYWN0aW9uID0ge1xuICAgICAgdHlwZTogZ2V0VHJhbnNhY3Rpb25UeXBlKHR4biksXG4gICAgICBpZGVudGlmaWVyOiBwYXJzZUludChpc091dGJvdW5kID8gdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgOiB0eG4udm91Y2hlck51bWJlclJhdHosIDEwKSxcbiAgICAgIGRhdGU6IHR4bk1vbWVudC50b0lTT1N0cmluZygpLFxuICAgICAgcHJvY2Vzc2VkRGF0ZTogY3VycmVudFByb2Nlc3NlZERhdGUsXG4gICAgICBvcmlnaW5hbEFtb3VudDogaXNPdXRib3VuZCA/IC10eG4uZGVhbFN1bU91dGJvdW5kIDogLXR4bi5kZWFsU3VtLFxuICAgICAgb3JpZ2luYWxDdXJyZW5jeTogY29udmVydEN1cnJlbmN5KHR4bi5jdXJyZW50UGF5bWVudEN1cnJlbmN5ID8/IHR4bi5jdXJyZW5jeUlkKSxcbiAgICAgIGNoYXJnZWRBbW91bnQ6IGlzT3V0Ym91bmQgPyAtdHhuLnBheW1lbnRTdW1PdXRib3VuZCA6IC10eG4ucGF5bWVudFN1bSxcbiAgICAgIGNoYXJnZWRDdXJyZW5jeTogY29udmVydEN1cnJlbmN5KHR4bi5jdXJyZW5jeUlkKSxcbiAgICAgIGRlc2NyaXB0aW9uOiBpc091dGJvdW5kID8gdHhuLmZ1bGxTdXBwbGllck5hbWVPdXRib3VuZCA6IHR4bi5mdWxsU3VwcGxpZXJOYW1lSGViLFxuICAgICAgbWVtbzogdHhuLm1vcmVJbmZvIHx8ICcnLFxuICAgICAgaW5zdGFsbG1lbnRzOiBnZXRJbnN0YWxsbWVudHNJbmZvKHR4bikgfHwgdW5kZWZpbmVkLFxuICAgICAgc3RhdHVzOiBUcmFuc2FjdGlvblN0YXR1c2VzLkNvbXBsZXRlZCxcbiAgICB9O1xuXG4gICAgaWYgKG9wdGlvbnM/LmluY2x1ZGVSYXdUcmFuc2FjdGlvbikge1xuICAgICAgcmVzdWx0LnJhd1RyYW5zYWN0aW9uID0gZ2V0UmF3VHJhbnNhY3Rpb24odHhuKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hUcmFuc2FjdGlvbnMoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBjb21wYW55U2VydmljZU9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgc3RhcnRNb21lbnQ6IE1vbWVudCxcbiAgbW9udGhNb21lbnQ6IE1vbWVudCxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4PiB7XG4gIGNvbnN0IGFjY291bnRzID0gYXdhaXQgZmV0Y2hBY2NvdW50cyhwYWdlLCBjb21wYW55U2VydmljZU9wdGlvbnMuc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcbiAgY29uc3QgZGF0YVVybCA9IGdldFRyYW5zYWN0aW9uc1VybChjb21wYW55U2VydmljZU9wdGlvbnMuc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcbiAgYXdhaXQgc2xlZXAoUkFURV9MSU1JVC5TTEVFUF9CRVRXRUVOKTtcbiAgZGVidWcoYGZldGNoaW5nIHRyYW5zYWN0aW9ucyBmcm9tICR7ZGF0YVVybH0gZm9yIG1vbnRoICR7bW9udGhNb21lbnQuZm9ybWF0KCdZWVlZLU1NJyl9YCk7XG4gIGNvbnN0IGRhdGFSZXN1bHQgPSBhd2FpdCBmZXRjaEdldFdpdGhpblBhZ2U8U2NyYXBlZFRyYW5zYWN0aW9uRGF0YT4ocGFnZSwgZGF0YVVybCk7XG4gIGlmIChkYXRhUmVzdWx0ICYmIF8uZ2V0KGRhdGFSZXN1bHQsICdIZWFkZXIuU3RhdHVzJykgPT09ICcxJyAmJiBkYXRhUmVzdWx0LkNhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4pIHtcbiAgICBjb25zdCBhY2NvdW50VHhuczogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4ID0ge307XG4gICAgYWNjb3VudHMuZm9yRWFjaChhY2NvdW50ID0+IHtcbiAgICAgIGNvbnN0IHR4bkdyb3VwczogU2NyYXBlZEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zW10gfCB1bmRlZmluZWQgPSBfLmdldChcbiAgICAgICAgZGF0YVJlc3VsdCxcbiAgICAgICAgYENhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4uSW5kZXgke2FjY291bnQuaW5kZXh9LkN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zYCxcbiAgICAgICk7XG4gICAgICBpZiAodHhuR3JvdXBzKSB7XG4gICAgICAgIGxldCBhbGxUeG5zOiBUcmFuc2FjdGlvbltdID0gW107XG4gICAgICAgIHR4bkdyb3Vwcy5mb3JFYWNoKHR4bkdyb3VwID0+IHtcbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuSXNyYWVsKSB7XG4gICAgICAgICAgICBjb25zdCB0eG5zID0gY29udmVydFRyYW5zYWN0aW9ucyh0eG5Hcm91cC50eG5Jc3JhZWwsIGFjY291bnQucHJvY2Vzc2VkRGF0ZSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4udHhucyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0eG5Hcm91cC50eG5BYnJvYWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHR4bnMgPSBjb252ZXJ0VHJhbnNhY3Rpb25zKHR4bkdyb3VwLnR4bkFicm9hZCwgYWNjb3VudC5wcm9jZXNzZWREYXRlLCBvcHRpb25zKTtcbiAgICAgICAgICAgIGFsbFR4bnMucHVzaCguLi50eG5zKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmICghb3B0aW9ucy5jb21iaW5lSW5zdGFsbG1lbnRzKSB7XG4gICAgICAgICAgYWxsVHhucyA9IGZpeEluc3RhbGxtZW50cyhhbGxUeG5zKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0aW9ucy5vdXRwdXREYXRhPy5lbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUgPz8gdHJ1ZSkge1xuICAgICAgICAgIGFsbFR4bnMgPSBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMoYWxsVHhucywgc3RhcnRNb21lbnQsIG9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cyB8fCBmYWxzZSk7XG4gICAgICAgIH1cbiAgICAgICAgYWNjb3VudFR4bnNbYWNjb3VudC5hY2NvdW50TnVtYmVyXSA9IHtcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBhY2NvdW50LmFjY291bnROdW1iZXIsXG4gICAgICAgICAgaW5kZXg6IGFjY291bnQuaW5kZXgsXG4gICAgICAgICAgdHhuczogYWxsVHhucyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gYWNjb3VudFR4bnM7XG4gIH1cblxuICByZXR1cm4ge307XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBtb250aDogTW9tZW50LFxuICBhY2NvdW50SW5kZXg6IG51bWJlcixcbiAgdHJhbnNhY3Rpb246IFRyYW5zYWN0aW9uLFxuKTogUHJvbWlzZTxUcmFuc2FjdGlvbj4ge1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKG9wdGlvbnMuc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdQaXJ0ZXlJc2thXzIwNCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnQ2FyZEluZGV4JywgYWNjb3VudEluZGV4LnRvU3RyaW5nKCkpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnc2hvdmFyUmF0eicsIHRyYW5zYWN0aW9uLmlkZW50aWZpZXIhLnRvU3RyaW5nKCkpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnbW9lZENoaXV2JywgbW9udGguZm9ybWF0KCdNTVlZWVknKSk7XG5cbiAgZGVidWcoYGZldGNoaW5nIGV4dHJhIHNjcmFwIGZvciB0cmFuc2FjdGlvbiAke3RyYW5zYWN0aW9uLmlkZW50aWZpZXJ9IGZvciBtb250aCAke21vbnRoLmZvcm1hdCgnWVlZWS1NTScpfWApO1xuICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRUcmFuc2FjdGlvbkRhdGE+KHBhZ2UsIHVybC50b1N0cmluZygpKTtcbiAgaWYgKCFkYXRhKSB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uO1xuICB9XG5cbiAgY29uc3QgcmF3Q2F0ZWdvcnkgPSBfLmdldChkYXRhLCAnUGlydGV5SXNrYV8yMDRCZWFuLnNlY3RvcicpID8/ICcnO1xuICByZXR1cm4ge1xuICAgIC4uLnRyYW5zYWN0aW9uLFxuICAgIGNhdGVnb3J5OiByYXdDYXRlZ29yeS50cmltKCksXG4gICAgcmF3VHJhbnNhY3Rpb246IGdldFJhd1RyYW5zYWN0aW9uKGRhdGEsIHRyYW5zYWN0aW9uKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RXh0cmFTY3JhcEFjY291bnQoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgYWNjb3VudE1hcDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4LFxuICBtb250aDogbW9tZW50Lk1vbWVudCxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4PiB7XG4gIGNvbnN0IGFjY291bnRzOiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXhbc3RyaW5nXVtdID0gW107XG4gIGZvciAoY29uc3QgYWNjb3VudCBvZiBPYmplY3QudmFsdWVzKGFjY291bnRNYXApKSB7XG4gICAgZGVidWcoXG4gICAgICBgZ2V0IGV4dHJhIHNjcmFwIGZvciAke2FjY291bnQuYWNjb3VudE51bWJlcn0gd2l0aCAke2FjY291bnQudHhucy5sZW5ndGh9IHRyYW5zYWN0aW9uc2AsXG4gICAgICBtb250aC5mb3JtYXQoJ1lZWVktTU0nKSxcbiAgICApO1xuICAgIGNvbnN0IHR4bnM6IFRyYW5zYWN0aW9uW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHR4bnNDaHVuayBvZiBfLmNodW5rKGFjY291bnQudHhucywgUkFURV9MSU1JVC5UUkFOU0FDVElPTlNfQkFUQ0hfU0laRSkpIHtcbiAgICAgIGRlYnVnKGBwcm9jZXNzaW5nIGNodW5rIG9mICR7dHhuc0NodW5rLmxlbmd0aH0gdHJhbnNhY3Rpb25zIGZvciBhY2NvdW50ICR7YWNjb3VudC5hY2NvdW50TnVtYmVyfWApO1xuICAgICAgY29uc3QgdXBkYXRlZFR4bnMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgdHhuc0NodW5rLm1hcCh0ID0+IGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihwYWdlLCBvcHRpb25zLCBtb250aCwgYWNjb3VudC5pbmRleCwgdCkpLFxuICAgICAgKTtcbiAgICAgIGF3YWl0IHNsZWVwKFJBVEVfTElNSVQuU0xFRVBfQkVUV0VFTik7XG4gICAgICB0eG5zLnB1c2goLi4udXBkYXRlZFR4bnMpO1xuICAgIH1cbiAgICBhY2NvdW50cy5wdXNoKHsgLi4uYWNjb3VudCwgdHhucyB9KTtcbiAgfVxuXG4gIHJldHVybiBhY2NvdW50cy5yZWR1Y2UoKG0sIHgpID0+ICh7IC4uLm0sIFt4LmFjY291bnROdW1iZXJdOiB4IH0pLCB7fSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uKFxuICBzY3JhcGVyT3B0aW9uczogU2NyYXBlck9wdGlvbnMsXG4gIGFjY291bnRzV2l0aEluZGV4OiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXhbXSxcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBhbGxNb250aHM6IG1vbWVudC5Nb21lbnRbXSxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10+IHtcbiAgaWYgKFxuICAgICFzY3JhcGVyT3B0aW9ucy5hZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbiB8fFxuICAgIHNjcmFwZXJPcHRpb25zLm9wdEluRmVhdHVyZXM/LmluY2x1ZGVzKCdpc3JhY2FyZC1hbWV4OnNraXBBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbicpXG4gICkge1xuICAgIHJldHVybiBhY2NvdW50c1dpdGhJbmRleDtcbiAgfVxuICByZXR1cm4gcnVuU2VyaWFsKGFjY291bnRzV2l0aEluZGV4Lm1hcCgoYSwgaSkgPT4gKCkgPT4gZ2V0RXh0cmFTY3JhcEFjY291bnQocGFnZSwgb3B0aW9ucywgYSwgYWxsTW9udGhzW2ldKSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFsbFRyYW5zYWN0aW9ucyhcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogU2NyYXBlck9wdGlvbnMsXG4gIGNvbXBhbnlTZXJ2aWNlT3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBzdGFydE1vbWVudDogTW9tZW50LFxuKSB7XG4gIGNvbnN0IGZ1dHVyZU1vbnRoc1RvU2NyYXBlID0gb3B0aW9ucy5mdXR1cmVNb250aHNUb1NjcmFwZSA/PyAxO1xuICBjb25zdCBhbGxNb250aHMgPSBnZXRBbGxNb250aE1vbWVudHMoc3RhcnRNb21lbnQsIGZ1dHVyZU1vbnRoc1RvU2NyYXBlKTtcbiAgY29uc3QgcmVzdWx0czogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10gPSBhd2FpdCBydW5TZXJpYWwoXG4gICAgYWxsTW9udGhzLm1hcChtb250aE1vbWVudCA9PiAoKSA9PiB7XG4gICAgICByZXR1cm4gZmV0Y2hUcmFuc2FjdGlvbnMocGFnZSwgb3B0aW9ucywgY29tcGFueVNlcnZpY2VPcHRpb25zLCBzdGFydE1vbWVudCwgbW9udGhNb21lbnQpO1xuICAgIH0pLFxuICApO1xuXG4gIGNvbnN0IGZpbmFsUmVzdWx0ID0gYXdhaXQgZ2V0QWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24oXG4gICAgb3B0aW9ucyxcbiAgICByZXN1bHRzLFxuICAgIHBhZ2UsXG4gICAgY29tcGFueVNlcnZpY2VPcHRpb25zLFxuICAgIGFsbE1vbnRocyxcbiAgKTtcbiAgY29uc3QgY29tYmluZWRUeG5zOiBSZWNvcmQ8c3RyaW5nLCBUcmFuc2FjdGlvbltdPiA9IHt9O1xuXG4gIGZpbmFsUmVzdWx0LmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICBPYmplY3Qua2V5cyhyZXN1bHQpLmZvckVhY2goYWNjb3VudE51bWJlciA9PiB7XG4gICAgICBsZXQgdHhuc0ZvckFjY291bnQgPSBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl07XG4gICAgICBpZiAoIXR4bnNGb3JBY2NvdW50KSB7XG4gICAgICAgIHR4bnNGb3JBY2NvdW50ID0gW107XG4gICAgICAgIGNvbWJpbmVkVHhuc1thY2NvdW50TnVtYmVyXSA9IHR4bnNGb3JBY2NvdW50O1xuICAgICAgfVxuICAgICAgY29uc3QgdG9CZUFkZGVkVHhucyA9IHJlc3VsdFthY2NvdW50TnVtYmVyXS50eG5zO1xuICAgICAgY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdLnB1c2goLi4udG9CZUFkZGVkVHhucyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGNvbnN0IGFjY291bnRzID0gT2JqZWN0LmtleXMoY29tYmluZWRUeG5zKS5tYXAoYWNjb3VudE51bWJlciA9PiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjY291bnROdW1iZXIsXG4gICAgICB0eG5zOiBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0sXG4gICAgfTtcbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGFjY291bnRzLFxuICB9O1xufVxuXG50eXBlIFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzID0geyBpZDogc3RyaW5nOyBwYXNzd29yZDogc3RyaW5nOyBjYXJkNkRpZ2l0czogc3RyaW5nIH07XG5jbGFzcyBJc3JhY2FyZEFtZXhCYXNlU2NyYXBlciBleHRlbmRzIEJhc2VTY3JhcGVyV2l0aEJyb3dzZXI8U2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHM+IHtcbiAgcHJpdmF0ZSBiYXNlVXJsOiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSBjb21wYW55Q29kZTogc3RyaW5nO1xuXG4gIHByaXZhdGUgc2VydmljZXNVcmw6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBTY3JhcGVyT3B0aW9ucywgYmFzZVVybDogc3RyaW5nLCBjb21wYW55Q29kZTogc3RyaW5nKSB7XG4gICAgc3VwZXIob3B0aW9ucyk7XG5cbiAgICB0aGlzLmJhc2VVcmwgPSBiYXNlVXJsO1xuICAgIHRoaXMuY29tcGFueUNvZGUgPSBjb21wYW55Q29kZTtcbiAgICB0aGlzLnNlcnZpY2VzVXJsID0gYCR7YmFzZVVybH0vc2VydmljZXMvUHJveHlSZXF1ZXN0SGFuZGxlci5hc2h4YDtcbiAgfVxuXG4gIGFzeW5jIGxvZ2luKGNyZWRlbnRpYWxzOiBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyk6IFByb21pc2U8U2NyYXBlclNjcmFwaW5nUmVzdWx0PiB7XG4gICAgYXdhaXQgdGhpcy5wYWdlLnNldFJlcXVlc3RJbnRlcmNlcHRpb24odHJ1ZSk7XG4gICAgdGhpcy5wYWdlLm9uKCdyZXF1ZXN0JywgcmVxdWVzdCA9PiB7XG4gICAgICBpZiAocmVxdWVzdC51cmwoKS5pbmNsdWRlcygnZGV0ZWN0b3ItZG9tLm1pbi5qcycpKSB7XG4gICAgICAgIGRlYnVnKCdmb3JjZSBhYm9ydCBmb3IgcmVxdWVzdCBkbyBkb3dubG9hZCBkZXRlY3Rvci1kb20ubWluLmpzIHJlc291cmNlJyk7XG4gICAgICAgIHZvaWQgcmVxdWVzdC5hYm9ydCh1bmRlZmluZWQsIGludGVyY2VwdGlvblByaW9yaXRpZXMuYWJvcnQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdm9pZCByZXF1ZXN0LmNvbnRpbnVlKHVuZGVmaW5lZCwgaW50ZXJjZXB0aW9uUHJpb3JpdGllcy5jb250aW51ZSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBhd2FpdCBtYXNrSGVhZGxlc3NVc2VyQWdlbnQodGhpcy5wYWdlKTtcblxuICAgIGF3YWl0IHRoaXMubmF2aWdhdGVUbyhgJHt0aGlzLmJhc2VVcmx9L3BlcnNvbmFsYXJlYS9Mb2dpbmApO1xuXG4gICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9nZ2luZ0luKTtcblxuICAgIGNvbnN0IHZhbGlkYXRlVXJsID0gYCR7dGhpcy5zZXJ2aWNlc1VybH0/cmVxTmFtZT1WYWxpZGF0ZUlkRGF0YWA7XG4gICAgY29uc3QgdmFsaWRhdGVSZXF1ZXN0ID0ge1xuICAgICAgaWQ6IGNyZWRlbnRpYWxzLmlkLFxuICAgICAgY2FyZFN1ZmZpeDogY3JlZGVudGlhbHMuY2FyZDZEaWdpdHMsXG4gICAgICBjb3VudHJ5Q29kZTogQ09VTlRSWV9DT0RFLFxuICAgICAgaWRUeXBlOiBJRF9UWVBFLFxuICAgICAgY2hlY2tMZXZlbDogJzEnLFxuICAgICAgY29tcGFueUNvZGU6IHRoaXMuY29tcGFueUNvZGUsXG4gICAgfTtcbiAgICBkZWJ1ZygnbG9nZ2luZyBpbiB3aXRoIHZhbGlkYXRlIHJlcXVlc3QnKTtcbiAgICBjb25zdCB2YWxpZGF0ZVJlc3VsdCA9IGF3YWl0IGZldGNoUG9zdFdpdGhpblBhZ2U8U2NyYXBlZExvZ2luVmFsaWRhdGlvbj4odGhpcy5wYWdlLCB2YWxpZGF0ZVVybCwgdmFsaWRhdGVSZXF1ZXN0KTtcbiAgICBpZiAoXG4gICAgICAhdmFsaWRhdGVSZXN1bHQgfHxcbiAgICAgICF2YWxpZGF0ZVJlc3VsdC5IZWFkZXIgfHxcbiAgICAgIHZhbGlkYXRlUmVzdWx0LkhlYWRlci5TdGF0dXMgIT09ICcxJyB8fFxuICAgICAgIXZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhblxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCd1bmtub3duIGVycm9yIGR1cmluZyBsb2dpbicpO1xuICAgIH1cblxuICAgIGNvbnN0IHZhbGlkYXRlUmV0dXJuQ29kZSA9IHZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhbi5yZXR1cm5Db2RlO1xuICAgIGRlYnVnKGB1c2VyIHZhbGlkYXRlIHdpdGggcmV0dXJuIGNvZGUgJyR7dmFsaWRhdGVSZXR1cm5Db2RlfSdgKTtcbiAgICBpZiAodmFsaWRhdGVSZXR1cm5Db2RlID09PSAnMScpIHtcbiAgICAgIGNvbnN0IHsgdXNlck5hbWUgfSA9IHZhbGlkYXRlUmVzdWx0LlZhbGlkYXRlSWREYXRhQmVhbjtcblxuICAgICAgY29uc3QgbG9naW5VcmwgPSBgJHt0aGlzLnNlcnZpY2VzVXJsfT9yZXFOYW1lPXBlcmZvcm1Mb2dvbklgO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAgICAgS29kTWlzaHRhbWVzaDogdXNlck5hbWUsXG4gICAgICAgIE1pc3BhclppaHV5OiBjcmVkZW50aWFscy5pZCxcbiAgICAgICAgU2lzbWE6IGNyZWRlbnRpYWxzLnBhc3N3b3JkLFxuICAgICAgICBjYXJkU3VmZml4OiBjcmVkZW50aWFscy5jYXJkNkRpZ2l0cyxcbiAgICAgICAgY291bnRyeUNvZGU6IENPVU5UUllfQ09ERSxcbiAgICAgICAgaWRUeXBlOiBJRF9UWVBFLFxuICAgICAgfTtcbiAgICAgIGRlYnVnKCd1c2VyIGxvZ2luIHN0YXJ0ZWQnKTtcbiAgICAgIGNvbnN0IGxvZ2luUmVzdWx0ID0gYXdhaXQgZmV0Y2hQb3N0V2l0aGluUGFnZTx7IHN0YXR1czogc3RyaW5nIH0+KHRoaXMucGFnZSwgbG9naW5VcmwsIHJlcXVlc3QpO1xuICAgICAgZGVidWcoYHVzZXIgbG9naW4gd2l0aCBzdGF0dXMgJyR7bG9naW5SZXN1bHQ/LnN0YXR1c30nYCwgbG9naW5SZXN1bHQpO1xuXG4gICAgICBpZiAobG9naW5SZXN1bHQgJiYgbG9naW5SZXN1bHQuc3RhdHVzID09PSAnMScpIHtcbiAgICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5TdWNjZXNzKTtcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuICAgICAgfVxuXG4gICAgICBpZiAobG9naW5SZXN1bHQgJiYgbG9naW5SZXN1bHQuc3RhdHVzID09PSAnMycpIHtcbiAgICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuQ2hhbmdlUGFzc3dvcmQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuQ2hhbmdlUGFzc3dvcmQsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkxvZ2luRmFpbGVkKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkludmFsaWRQYXNzd29yZCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKHZhbGlkYXRlUmV0dXJuQ29kZSA9PT0gJzQnKSB7XG4gICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5DaGFuZ2VQYXNzd29yZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5DaGFuZ2VQYXNzd29yZCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5GYWlsZWQpO1xuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuSW52YWxpZFBhc3N3b3JkLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBmZXRjaERhdGEoKSB7XG4gICAgY29uc3QgZGVmYXVsdFN0YXJ0TW9tZW50ID0gbW9tZW50KCkuc3VidHJhY3QoMSwgJ3llYXJzJyk7XG4gICAgY29uc3Qgc3RhcnREYXRlID0gdGhpcy5vcHRpb25zLnN0YXJ0RGF0ZSB8fCBkZWZhdWx0U3RhcnRNb21lbnQudG9EYXRlKCk7XG4gICAgY29uc3Qgc3RhcnRNb21lbnQgPSBtb21lbnQubWF4KGRlZmF1bHRTdGFydE1vbWVudCwgbW9tZW50KHN0YXJ0RGF0ZSkpO1xuXG4gICAgcmV0dXJuIGZldGNoQWxsVHJhbnNhY3Rpb25zKFxuICAgICAgdGhpcy5wYWdlLFxuICAgICAgdGhpcy5vcHRpb25zLFxuICAgICAge1xuICAgICAgICBzZXJ2aWNlc1VybDogdGhpcy5zZXJ2aWNlc1VybCxcbiAgICAgICAgY29tcGFueUNvZGU6IHRoaXMuY29tcGFueUNvZGUsXG4gICAgICB9LFxuICAgICAgc3RhcnRNb21lbnQsXG4gICAgKTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBJc3JhY2FyZEFtZXhCYXNlU2NyYXBlcjtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsSUFBQUEsT0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBRUEsSUFBQUUsVUFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsWUFBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksTUFBQSxHQUFBTCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssTUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFB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