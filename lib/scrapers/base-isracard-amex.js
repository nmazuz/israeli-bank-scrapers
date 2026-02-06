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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbG9kYXNoIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfbW9tZW50IiwiX2NvbnN0YW50cyIsIl9kZWZpbml0aW9ucyIsIl9kYXRlcyIsIl9kZWJ1ZyIsIl9mZXRjaCIsIl90cmFuc2FjdGlvbnMiLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMyIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXJyb3JzIiwiX2Jyb3dzZXIiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJSQVRFX0xJTUlUIiwiU0xFRVBfQkVUV0VFTiIsIlRSQU5TQUNUSU9OU19CQVRDSF9TSVpFIiwiQ09VTlRSWV9DT0RFIiwiSURfVFlQRSIsIklOU1RBTExNRU5UU19LRVlXT1JEIiwiREFURV9GT1JNQVQiLCJkZWJ1ZyIsImdldERlYnVnIiwiZ2V0QWNjb3VudHNVcmwiLCJzZXJ2aWNlc1VybCIsIm1vbnRoTW9tZW50IiwiYmlsbGluZ0RhdGUiLCJmb3JtYXQiLCJ1cmwiLCJVUkwiLCJzZWFyY2hQYXJhbXMiLCJzZXQiLCJ0b1N0cmluZyIsImZldGNoQWNjb3VudHMiLCJwYWdlIiwiZGF0YVVybCIsImRhdGFSZXN1bHQiLCJmZXRjaEdldFdpdGhpblBhZ2UiLCJfIiwiZ2V0IiwiRGFzaGJvYXJkTW9udGhCZWFuIiwiY2FyZHNDaGFyZ2VzIiwibWFwIiwiY2FyZENoYXJnZSIsImluZGV4IiwicGFyc2VJbnQiLCJjYXJkSW5kZXgiLCJhY2NvdW50TnVtYmVyIiwiY2FyZE51bWJlciIsInByb2Nlc3NlZERhdGUiLCJtb21lbnQiLCJ0b0lTT1N0cmluZyIsImdldFRyYW5zYWN0aW9uc1VybCIsIm1vbnRoIiwieWVhciIsIm1vbnRoU3RyIiwiY29udmVydEN1cnJlbmN5IiwiY3VycmVuY3lTdHIiLCJTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCIsIkFMVF9TSEVLRUxfQ1VSUkVOQ1kiLCJTSEVLRUxfQ1VSUkVOQ1kiLCJnZXRJbnN0YWxsbWVudHNJbmZvIiwidHhuIiwibW9yZUluZm8iLCJpbmNsdWRlcyIsInVuZGVmaW5lZCIsIm1hdGNoZXMiLCJtYXRjaCIsImxlbmd0aCIsIm51bWJlciIsInRvdGFsIiwiZ2V0VHJhbnNhY3Rpb25UeXBlIiwiVHJhbnNhY3Rpb25UeXBlcyIsIkluc3RhbGxtZW50cyIsIk5vcm1hbCIsImNvbnZlcnRUcmFuc2FjdGlvbnMiLCJ0eG5zIiwib3B0aW9ucyIsImZpbHRlcmVkVHhucyIsImZpbHRlciIsImRlYWxTdW1UeXBlIiwidm91Y2hlck51bWJlclJhdHoiLCJ2b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIiwiaXNPdXRib3VuZCIsImRlYWxTdW1PdXRib3VuZCIsInR4bkRhdGVTdHIiLCJmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQiLCJmdWxsUHVyY2hhc2VEYXRlIiwidHhuTW9tZW50IiwiY3VycmVudFByb2Nlc3NlZERhdGUiLCJmdWxsUGF5bWVudERhdGUiLCJyZXN1bHQiLCJ0eXBlIiwiaWRlbnRpZmllciIsImRhdGUiLCJvcmlnaW5hbEFtb3VudCIsImRlYWxTdW0iLCJvcmlnaW5hbEN1cnJlbmN5IiwiY3VycmVudFBheW1lbnRDdXJyZW5jeSIsImN1cnJlbmN5SWQiLCJjaGFyZ2VkQW1vdW50IiwicGF5bWVudFN1bU91dGJvdW5kIiwicGF5bWVudFN1bSIsImNoYXJnZWRDdXJyZW5jeSIsImRlc2NyaXB0aW9uIiwiZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIiwiZnVsbFN1cHBsaWVyTmFtZUhlYiIsIm1lbW8iLCJpbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiQ29tcGxldGVkIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsImZldGNoVHJhbnNhY3Rpb25zIiwiY29tcGFueVNlcnZpY2VPcHRpb25zIiwic3RhcnRNb21lbnQiLCJhY2NvdW50cyIsInNsZWVwIiwiQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbiIsImFjY291bnRUeG5zIiwiZm9yRWFjaCIsImFjY291bnQiLCJ0eG5Hcm91cHMiLCJhbGxUeG5zIiwidHhuR3JvdXAiLCJ0eG5Jc3JhZWwiLCJwdXNoIiwidHhuQWJyb2FkIiwiY29tYmluZUluc3RhbGxtZW50cyIsImZpeEluc3RhbGxtZW50cyIsIm91dHB1dERhdGEiLCJlbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUiLCJmaWx0ZXJPbGRUcmFuc2FjdGlvbnMiLCJnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24iLCJhY2NvdW50SW5kZXgiLCJ0cmFuc2FjdGlvbiIsImRhdGEiLCJyYXdDYXRlZ29yeSIsImNhdGVnb3J5IiwidHJpbSIsImdldEV4dHJhU2NyYXBBY2NvdW50IiwiYWNjb3VudE1hcCIsIk9iamVjdCIsInZhbHVlcyIsInR4bnNDaHVuayIsImNodW5rIiwidXBkYXRlZFR4bnMiLCJQcm9taXNlIiwiYWxsIiwidCIsInJlZHVjZSIsIm0iLCJ4IiwiZ2V0QWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJzY3JhcGVyT3B0aW9ucyIsImFjY291bnRzV2l0aEluZGV4IiwiYWxsTW9udGhzIiwiYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24iLCJvcHRJbkZlYXR1cmVzIiwicnVuU2VyaWFsIiwiYSIsImkiLCJmZXRjaEFsbFRyYW5zYWN0aW9ucyIsImZ1dHVyZU1vbnRoc1RvU2NyYXBlIiwiZ2V0QWxsTW9udGhNb21lbnRzIiwicmVzdWx0cyIsImZpbmFsUmVzdWx0IiwiY29tYmluZWRUeG5zIiwia2V5cyIsInR4bnNGb3JBY2NvdW50IiwidG9CZUFkZGVkVHhucyIsInN1Y2Nlc3MiLCJJc3JhY2FyZEFtZXhCYXNlU2NyYXBlciIsIkJhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJjb25zdHJ1Y3RvciIsImJhc2VVcmwiLCJjb21wYW55Q29kZSIsImxvZ2luIiwiY3JlZGVudGlhbHMiLCJtYXNrSGVhZGxlc3NVc2VyQWdlbnQiLCJzZXRSZXF1ZXN0SW50ZXJjZXB0aW9uIiwib24iLCJyZXF1ZXN0IiwiYWJvcnQiLCJpbnRlcmNlcHRpb25Qcmlvcml0aWVzIiwiY29udGludWUiLCJuYXZpZ2F0ZVRvIiwid2FpdEZvclNlbGVjdG9yIiwidmlzaWJsZSIsInRpbWVvdXQiLCJjbGljayIsImVtaXRQcm9ncmVzcyIsIlNjcmFwZXJQcm9ncmVzc1R5cGVzIiwiTG9nZ2luZ0luIiwidmFsaWRhdGVVcmwiLCJ2YWxpZGF0ZVJlcXVlc3QiLCJpZCIsImNhcmRTdWZmaXgiLCJjYXJkNkRpZ2l0cyIsImNvdW50cnlDb2RlIiwiaWRUeXBlIiwiY2hlY2tMZXZlbCIsInZhbGlkYXRlUmVzdWx0IiwiZmV0Y2hQb3N0V2l0aGluUGFnZSIsIkhlYWRlciIsIlN0YXR1cyIsIlZhbGlkYXRlSWREYXRhQmVhbiIsIkVycm9yIiwidmFsaWRhdGVSZXR1cm5Db2RlIiwicmV0dXJuQ29kZSIsInVzZXJOYW1lIiwibG9naW5VcmwiLCJLb2RNaXNodGFtZXNoIiwiTWlzcGFyWmlodXkiLCJTaXNtYSIsInBhc3N3b3JkIiwibG9naW5SZXN1bHQiLCJMb2dpblN1Y2Nlc3MiLCJDaGFuZ2VQYXNzd29yZCIsImVycm9yVHlwZSIsIlNjcmFwZXJFcnJvclR5cGVzIiwiTG9naW5GYWlsZWQiLCJJbnZhbGlkUGFzc3dvcmQiLCJmZXRjaERhdGEiLCJkZWZhdWx0U3RhcnRNb21lbnQiLCJzdWJ0cmFjdCIsInN0YXJ0RGF0ZSIsInRvRGF0ZSIsIm1heCIsIl9kZWZhdWx0IiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9zY3JhcGVycy9iYXNlLWlzcmFjYXJkLWFtZXgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBtb21lbnQsIHsgdHlwZSBNb21lbnQgfSBmcm9tICdtb21lbnQnO1xuaW1wb3J0IHsgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcbmltcG9ydCB7IEFMVF9TSEVLRUxfQ1VSUkVOQ1ksIFNIRUtFTF9DVVJSRU5DWSwgU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfSBmcm9tICcuLi9jb25zdGFudHMnO1xuaW1wb3J0IHsgU2NyYXBlclByb2dyZXNzVHlwZXMgfSBmcm9tICcuLi9kZWZpbml0aW9ucyc7XG5pbXBvcnQgZ2V0QWxsTW9udGhNb21lbnRzIGZyb20gJy4uL2hlbHBlcnMvZGF0ZXMnO1xuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcbmltcG9ydCB7IGZldGNoR2V0V2l0aGluUGFnZSwgZmV0Y2hQb3N0V2l0aGluUGFnZSB9IGZyb20gJy4uL2hlbHBlcnMvZmV0Y2gnO1xuaW1wb3J0IHsgZmlsdGVyT2xkVHJhbnNhY3Rpb25zLCBmaXhJbnN0YWxsbWVudHMsIGdldFJhd1RyYW5zYWN0aW9uIH0gZnJvbSAnLi4vaGVscGVycy90cmFuc2FjdGlvbnMnO1xuaW1wb3J0IHsgcnVuU2VyaWFsLCBzbGVlcCB9IGZyb20gJy4uL2hlbHBlcnMvd2FpdGluZyc7XG5pbXBvcnQge1xuICBUcmFuc2FjdGlvblN0YXR1c2VzLFxuICBUcmFuc2FjdGlvblR5cGVzLFxuICB0eXBlIFRyYW5zYWN0aW9uLFxuICB0eXBlIFRyYW5zYWN0aW9uSW5zdGFsbG1lbnRzLFxuICB0eXBlIFRyYW5zYWN0aW9uc0FjY291bnQsXG59IGZyb20gJy4uL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyIH0gZnJvbSAnLi9iYXNlLXNjcmFwZXItd2l0aC1icm93c2VyJztcbmltcG9ydCB7IFNjcmFwZXJFcnJvclR5cGVzIH0gZnJvbSAnLi9lcnJvcnMnO1xuaW1wb3J0IHsgdHlwZSBTY3JhcGVyT3B0aW9ucywgdHlwZSBTY3JhcGVyU2NyYXBpbmdSZXN1bHQgfSBmcm9tICcuL2ludGVyZmFjZSc7XG5pbXBvcnQgeyBpbnRlcmNlcHRpb25Qcmlvcml0aWVzLCBtYXNrSGVhZGxlc3NVc2VyQWdlbnQgfSBmcm9tICcuLi9oZWxwZXJzL2Jyb3dzZXInO1xuXG5jb25zdCBSQVRFX0xJTUlUID0ge1xuICBTTEVFUF9CRVRXRUVOOiAxMDAwLFxuICBUUkFOU0FDVElPTlNfQkFUQ0hfU0laRTogMTAsXG59IGFzIGNvbnN0O1xuXG5jb25zdCBDT1VOVFJZX0NPREUgPSAnMjEyJztcbmNvbnN0IElEX1RZUEUgPSAnMSc7XG5jb25zdCBJTlNUQUxMTUVOVFNfS0VZV09SRCA9ICfXqtep15zXldedJztcblxuY29uc3QgREFURV9GT1JNQVQgPSAnREQvTU0vWVlZWSc7XG5cbmNvbnN0IGRlYnVnID0gZ2V0RGVidWcoJ2Jhc2UtaXNyYWNhcmQtYW1leCcpO1xuXG50eXBlIENvbXBhbnlTZXJ2aWNlT3B0aW9ucyA9IHtcbiAgc2VydmljZXNVcmw6IHN0cmluZztcbiAgY29tcGFueUNvZGU6IHN0cmluZztcbn07XG5cbnR5cGUgU2NyYXBlZEFjY291bnRzV2l0aEluZGV4ID0gUmVjb3JkPHN0cmluZywgVHJhbnNhY3Rpb25zQWNjb3VudCAmIHsgaW5kZXg6IG51bWJlciB9PjtcblxuaW50ZXJmYWNlIFNjcmFwZWRUcmFuc2FjdGlvbiB7XG4gIGRlYWxTdW1UeXBlOiBzdHJpbmc7XG4gIHZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQ6IHN0cmluZztcbiAgdm91Y2hlck51bWJlclJhdHo6IHN0cmluZztcbiAgbW9yZUluZm8/OiBzdHJpbmc7XG4gIGRlYWxTdW1PdXRib3VuZDogYm9vbGVhbjtcbiAgY3VycmVuY3lJZDogc3RyaW5nO1xuICBjdXJyZW50UGF5bWVudEN1cnJlbmN5OiBzdHJpbmc7XG4gIGRlYWxTdW06IG51bWJlcjtcbiAgZnVsbFBheW1lbnREYXRlPzogc3RyaW5nO1xuICBmdWxsUHVyY2hhc2VEYXRlPzogc3RyaW5nO1xuICBmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQ/OiBzdHJpbmc7XG4gIGZ1bGxTdXBwbGllck5hbWVIZWI6IHN0cmluZztcbiAgZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kOiBzdHJpbmc7XG4gIHBheW1lbnRTdW06IG51bWJlcjtcbiAgcGF5bWVudFN1bU91dGJvdW5kOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBTY3JhcGVkQWNjb3VudCB7XG4gIGluZGV4OiBudW1iZXI7XG4gIGFjY291bnROdW1iZXI6IHN0cmluZztcbiAgcHJvY2Vzc2VkRGF0ZTogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZExvZ2luVmFsaWRhdGlvbiB7XG4gIEhlYWRlcjoge1xuICAgIFN0YXR1czogc3RyaW5nO1xuICB9O1xuICBWYWxpZGF0ZUlkRGF0YUJlYW4/OiB7XG4gICAgdXNlck5hbWU/OiBzdHJpbmc7XG4gICAgcmV0dXJuQ29kZTogc3RyaW5nO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZEFjY291bnRzV2l0aGluUGFnZVJlc3BvbnNlIHtcbiAgSGVhZGVyOiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIERhc2hib2FyZE1vbnRoQmVhbj86IHtcbiAgICBjYXJkc0NoYXJnZXM6IHtcbiAgICAgIGNhcmRJbmRleDogc3RyaW5nO1xuICAgICAgY2FyZE51bWJlcjogc3RyaW5nO1xuICAgICAgYmlsbGluZ0RhdGU6IHN0cmluZztcbiAgICB9W107XG4gIH07XG59XG5cbmludGVyZmFjZSBTY3JhcGVkQ3VycmVudENhcmRUcmFuc2FjdGlvbnMge1xuICB0eG5Jc3JhZWw/OiBTY3JhcGVkVHJhbnNhY3Rpb25bXTtcbiAgdHhuQWJyb2FkPzogU2NyYXBlZFRyYW5zYWN0aW9uW107XG59XG5cbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb25EYXRhIHtcbiAgSGVhZGVyPzoge1xuICAgIFN0YXR1czogc3RyaW5nO1xuICB9O1xuICBQaXJ0ZXlJc2thXzIwNEJlYW4/OiB7XG4gICAgc2VjdG9yOiBzdHJpbmc7XG4gIH07XG5cbiAgQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbj86IFJlY29yZDxcbiAgICBzdHJpbmcsXG4gICAge1xuICAgICAgQ3VycmVudENhcmRUcmFuc2FjdGlvbnM6IFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9uc1tdO1xuICAgIH1cbiAgPjtcbn1cblxuZnVuY3Rpb24gZ2V0QWNjb3VudHNVcmwoc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCkge1xuICBjb25zdCBiaWxsaW5nRGF0ZSA9IG1vbnRoTW9tZW50LmZvcm1hdCgnWVlZWS1NTS1ERCcpO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlcnZpY2VzVXJsKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnRGFzaGJvYXJkTW9udGgnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2FjdGlvbkNvZGUnLCAnMCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnYmlsbGluZ0RhdGUnLCBiaWxsaW5nRGF0ZSk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdmb3JtYXQnLCAnSnNvbicpO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoQWNjb3VudHMocGFnZTogUGFnZSwgc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCk6IFByb21pc2U8U2NyYXBlZEFjY291bnRbXT4ge1xuICBjb25zdCBkYXRhVXJsID0gZ2V0QWNjb3VudHNVcmwoc2VydmljZXNVcmwsIG1vbnRoTW9tZW50KTtcbiAgZGVidWcoYGZldGNoaW5nIGFjY291bnRzIGZyb20gJHtkYXRhVXJsfWApO1xuICBjb25zdCBkYXRhUmVzdWx0ID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRBY2NvdW50c1dpdGhpblBhZ2VSZXNwb25zZT4ocGFnZSwgZGF0YVVybCk7XG4gIGlmIChkYXRhUmVzdWx0ICYmIF8uZ2V0KGRhdGFSZXN1bHQsICdIZWFkZXIuU3RhdHVzJykgPT09ICcxJyAmJiBkYXRhUmVzdWx0LkRhc2hib2FyZE1vbnRoQmVhbikge1xuICAgIGNvbnN0IHsgY2FyZHNDaGFyZ2VzIH0gPSBkYXRhUmVzdWx0LkRhc2hib2FyZE1vbnRoQmVhbjtcbiAgICBpZiAoY2FyZHNDaGFyZ2VzKSB7XG4gICAgICByZXR1cm4gY2FyZHNDaGFyZ2VzLm1hcChjYXJkQ2hhcmdlID0+IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpbmRleDogcGFyc2VJbnQoY2FyZENoYXJnZS5jYXJkSW5kZXgsIDEwKSxcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBjYXJkQ2hhcmdlLmNhcmROdW1iZXIsXG4gICAgICAgICAgcHJvY2Vzc2VkRGF0ZTogbW9tZW50KGNhcmRDaGFyZ2UuYmlsbGluZ0RhdGUsIERBVEVfRk9STUFUKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbXTtcbn1cblxuZnVuY3Rpb24gZ2V0VHJhbnNhY3Rpb25zVXJsKHNlcnZpY2VzVXJsOiBzdHJpbmcsIG1vbnRoTW9tZW50OiBNb21lbnQpIHtcbiAgY29uc3QgbW9udGggPSBtb250aE1vbWVudC5tb250aCgpICsgMTtcbiAgY29uc3QgeWVhciA9IG1vbnRoTW9tZW50LnllYXIoKTtcbiAgY29uc3QgbW9udGhTdHIgPSBtb250aCA8IDEwID8gYDAke21vbnRofWAgOiBtb250aC50b1N0cmluZygpO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlcnZpY2VzVXJsKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnQ2FyZHNUcmFuc2FjdGlvbnNMaXN0Jyk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdtb250aCcsIG1vbnRoU3RyKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3llYXInLCBgJHt5ZWFyfWApO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxdWlyZWREYXRlJywgJ04nKTtcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0Q3VycmVuY3koY3VycmVuY3lTdHI6IHN0cmluZykge1xuICBpZiAoY3VycmVuY3lTdHIgPT09IFNIRUtFTF9DVVJSRU5DWV9LRVlXT1JEIHx8IGN1cnJlbmN5U3RyID09PSBBTFRfU0hFS0VMX0NVUlJFTkNZKSB7XG4gICAgcmV0dXJuIFNIRUtFTF9DVVJSRU5DWTtcbiAgfVxuICByZXR1cm4gY3VycmVuY3lTdHI7XG59XG5cbmZ1bmN0aW9uIGdldEluc3RhbGxtZW50c0luZm8odHhuOiBTY3JhcGVkVHJhbnNhY3Rpb24pOiBUcmFuc2FjdGlvbkluc3RhbGxtZW50cyB8IHVuZGVmaW5lZCB7XG4gIGlmICghdHhuLm1vcmVJbmZvIHx8ICF0eG4ubW9yZUluZm8uaW5jbHVkZXMoSU5TVEFMTE1FTlRTX0tFWVdPUkQpKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBjb25zdCBtYXRjaGVzID0gdHhuLm1vcmVJbmZvLm1hdGNoKC9cXGQrL2cpO1xuICBpZiAoIW1hdGNoZXMgfHwgbWF0Y2hlcy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbnVtYmVyOiBwYXJzZUludChtYXRjaGVzWzBdLCAxMCksXG4gICAgdG90YWw6IHBhcnNlSW50KG1hdGNoZXNbMV0sIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZ2V0VHJhbnNhY3Rpb25UeXBlKHR4bjogU2NyYXBlZFRyYW5zYWN0aW9uKSB7XG4gIHJldHVybiBnZXRJbnN0YWxsbWVudHNJbmZvKHR4bikgPyBUcmFuc2FjdGlvblR5cGVzLkluc3RhbGxtZW50cyA6IFRyYW5zYWN0aW9uVHlwZXMuTm9ybWFsO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0VHJhbnNhY3Rpb25zKFxuICB0eG5zOiBTY3JhcGVkVHJhbnNhY3Rpb25bXSxcbiAgcHJvY2Vzc2VkRGF0ZTogc3RyaW5nLFxuICBvcHRpb25zPzogU2NyYXBlck9wdGlvbnMsXG4pOiBUcmFuc2FjdGlvbltdIHtcbiAgY29uc3QgZmlsdGVyZWRUeG5zID0gdHhucy5maWx0ZXIoXG4gICAgdHhuID0+XG4gICAgICB0eG4uZGVhbFN1bVR5cGUgIT09ICcxJyAmJiB0eG4udm91Y2hlck51bWJlclJhdHogIT09ICcwMDAwMDAwMDAnICYmIHR4bi52b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kICE9PSAnMDAwMDAwMDAwJyxcbiAgKTtcblxuICByZXR1cm4gZmlsdGVyZWRUeG5zLm1hcCh0eG4gPT4ge1xuICAgIGNvbnN0IGlzT3V0Ym91bmQgPSB0eG4uZGVhbFN1bU91dGJvdW5kO1xuICAgIGNvbnN0IHR4bkRhdGVTdHIgPSBpc091dGJvdW5kID8gdHhuLmZ1bGxQdXJjaGFzZURhdGVPdXRib3VuZCA6IHR4bi5mdWxsUHVyY2hhc2VEYXRlO1xuICAgIGNvbnN0IHR4bk1vbWVudCA9IG1vbWVudCh0eG5EYXRlU3RyLCBEQVRFX0ZPUk1BVCk7XG5cbiAgICBjb25zdCBjdXJyZW50UHJvY2Vzc2VkRGF0ZSA9IHR4bi5mdWxsUGF5bWVudERhdGVcbiAgICAgID8gbW9tZW50KHR4bi5mdWxsUGF5bWVudERhdGUsIERBVEVfRk9STUFUKS50b0lTT1N0cmluZygpXG4gICAgICA6IHByb2Nlc3NlZERhdGU7XG4gICAgY29uc3QgcmVzdWx0OiBUcmFuc2FjdGlvbiA9IHtcbiAgICAgIHR5cGU6IGdldFRyYW5zYWN0aW9uVHlwZSh0eG4pLFxuICAgICAgaWRlbnRpZmllcjogcGFyc2VJbnQoaXNPdXRib3VuZCA/IHR4bi52b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIDogdHhuLnZvdWNoZXJOdW1iZXJSYXR6LCAxMCksXG4gICAgICBkYXRlOiB0eG5Nb21lbnQudG9JU09TdHJpbmcoKSxcbiAgICAgIHByb2Nlc3NlZERhdGU6IGN1cnJlbnRQcm9jZXNzZWREYXRlLFxuICAgICAgb3JpZ2luYWxBbW91bnQ6IGlzT3V0Ym91bmQgPyAtdHhuLmRlYWxTdW1PdXRib3VuZCA6IC10eG4uZGVhbFN1bSxcbiAgICAgIG9yaWdpbmFsQ3VycmVuY3k6IGNvbnZlcnRDdXJyZW5jeSh0eG4uY3VycmVudFBheW1lbnRDdXJyZW5jeSA/PyB0eG4uY3VycmVuY3lJZCksXG4gICAgICBjaGFyZ2VkQW1vdW50OiBpc091dGJvdW5kID8gLXR4bi5wYXltZW50U3VtT3V0Ym91bmQgOiAtdHhuLnBheW1lbnRTdW0sXG4gICAgICBjaGFyZ2VkQ3VycmVuY3k6IGNvbnZlcnRDdXJyZW5jeSh0eG4uY3VycmVuY3lJZCksXG4gICAgICBkZXNjcmlwdGlvbjogaXNPdXRib3VuZCA/IHR4bi5mdWxsU3VwcGxpZXJOYW1lT3V0Ym91bmQgOiB0eG4uZnVsbFN1cHBsaWVyTmFtZUhlYixcbiAgICAgIG1lbW86IHR4bi5tb3JlSW5mbyB8fCAnJyxcbiAgICAgIGluc3RhbGxtZW50czogZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG4pIHx8IHVuZGVmaW5lZCxcbiAgICAgIHN0YXR1czogVHJhbnNhY3Rpb25TdGF0dXNlcy5Db21wbGV0ZWQsXG4gICAgfTtcblxuICAgIGlmIChvcHRpb25zPy5pbmNsdWRlUmF3VHJhbnNhY3Rpb24pIHtcbiAgICAgIHJlc3VsdC5yYXdUcmFuc2FjdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHR4bik7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoVHJhbnNhY3Rpb25zKFxuICBwYWdlOiBQYWdlLFxuICBvcHRpb25zOiBTY3JhcGVyT3B0aW9ucyxcbiAgY29tcGFueVNlcnZpY2VPcHRpb25zOiBDb21wYW55U2VydmljZU9wdGlvbnMsXG4gIHN0YXJ0TW9tZW50OiBNb21lbnQsXG4gIG1vbnRoTW9tZW50OiBNb21lbnQsXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleD4ge1xuICBjb25zdCBhY2NvdW50cyA9IGF3YWl0IGZldGNoQWNjb3VudHMocGFnZSwgY29tcGFueVNlcnZpY2VPcHRpb25zLnNlcnZpY2VzVXJsLCBtb250aE1vbWVudCk7XG4gIGNvbnN0IGRhdGFVcmwgPSBnZXRUcmFuc2FjdGlvbnNVcmwoY29tcGFueVNlcnZpY2VPcHRpb25zLnNlcnZpY2VzVXJsLCBtb250aE1vbWVudCk7XG4gIGF3YWl0IHNsZWVwKFJBVEVfTElNSVQuU0xFRVBfQkVUV0VFTik7XG4gIGRlYnVnKGBmZXRjaGluZyB0cmFuc2FjdGlvbnMgZnJvbSAke2RhdGFVcmx9IGZvciBtb250aCAke21vbnRoTW9tZW50LmZvcm1hdCgnWVlZWS1NTScpfWApO1xuICBjb25zdCBkYXRhUmVzdWx0ID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRUcmFuc2FjdGlvbkRhdGE+KHBhZ2UsIGRhdGFVcmwpO1xuICBpZiAoZGF0YVJlc3VsdCAmJiBfLmdldChkYXRhUmVzdWx0LCAnSGVhZGVyLlN0YXR1cycpID09PSAnMScgJiYgZGF0YVJlc3VsdC5DYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuKSB7XG4gICAgY29uc3QgYWNjb3VudFR4bnM6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleCA9IHt9O1xuICAgIGFjY291bnRzLmZvckVhY2goYWNjb3VudCA9PiB7XG4gICAgICBjb25zdCB0eG5Hcm91cHM6IFNjcmFwZWRDdXJyZW50Q2FyZFRyYW5zYWN0aW9uc1tdIHwgdW5kZWZpbmVkID0gXy5nZXQoXG4gICAgICAgIGRhdGFSZXN1bHQsXG4gICAgICAgIGBDYXJkc1RyYW5zYWN0aW9uc0xpc3RCZWFuLkluZGV4JHthY2NvdW50LmluZGV4fS5DdXJyZW50Q2FyZFRyYW5zYWN0aW9uc2AsXG4gICAgICApO1xuICAgICAgaWYgKHR4bkdyb3Vwcykge1xuICAgICAgICBsZXQgYWxsVHhuczogVHJhbnNhY3Rpb25bXSA9IFtdO1xuICAgICAgICB0eG5Hcm91cHMuZm9yRWFjaCh0eG5Hcm91cCA9PiB7XG4gICAgICAgICAgaWYgKHR4bkdyb3VwLnR4bklzcmFlbCkge1xuICAgICAgICAgICAgY29uc3QgdHhucyA9IGNvbnZlcnRUcmFuc2FjdGlvbnModHhuR3JvdXAudHhuSXNyYWVsLCBhY2NvdW50LnByb2Nlc3NlZERhdGUsIG9wdGlvbnMpO1xuICAgICAgICAgICAgYWxsVHhucy5wdXNoKC4uLnR4bnMpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuQWJyb2FkKSB7XG4gICAgICAgICAgICBjb25zdCB0eG5zID0gY29udmVydFRyYW5zYWN0aW9ucyh0eG5Hcm91cC50eG5BYnJvYWQsIGFjY291bnQucHJvY2Vzc2VkRGF0ZSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4udHhucyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoIW9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cykge1xuICAgICAgICAgIGFsbFR4bnMgPSBmaXhJbnN0YWxsbWVudHMoYWxsVHhucyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdGlvbnMub3V0cHV0RGF0YT8uZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlID8/IHRydWUpIHtcbiAgICAgICAgICBhbGxUeG5zID0gZmlsdGVyT2xkVHJhbnNhY3Rpb25zKGFsbFR4bnMsIHN0YXJ0TW9tZW50LCBvcHRpb25zLmNvbWJpbmVJbnN0YWxsbWVudHMgfHwgZmFsc2UpO1xuICAgICAgICB9XG4gICAgICAgIGFjY291bnRUeG5zW2FjY291bnQuYWNjb3VudE51bWJlcl0gPSB7XG4gICAgICAgICAgYWNjb3VudE51bWJlcjogYWNjb3VudC5hY2NvdW50TnVtYmVyLFxuICAgICAgICAgIGluZGV4OiBhY2NvdW50LmluZGV4LFxuICAgICAgICAgIHR4bnM6IGFsbFR4bnMsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIGFjY291bnRUeG5zO1xuICB9XG5cbiAgcmV0dXJuIHt9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24oXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgbW9udGg6IE1vbWVudCxcbiAgYWNjb3VudEluZGV4OiBudW1iZXIsXG4gIHRyYW5zYWN0aW9uOiBUcmFuc2FjdGlvbixcbik6IFByb21pc2U8VHJhbnNhY3Rpb24+IHtcbiAgY29uc3QgdXJsID0gbmV3IFVSTChvcHRpb25zLnNlcnZpY2VzVXJsKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3JlcU5hbWUnLCAnUGlydGV5SXNrYV8yMDQnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ0NhcmRJbmRleCcsIGFjY291bnRJbmRleC50b1N0cmluZygpKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3Nob3ZhclJhdHonLCB0cmFuc2FjdGlvbi5pZGVudGlmaWVyIS50b1N0cmluZygpKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ21vZWRDaGl1dicsIG1vbnRoLmZvcm1hdCgnTU1ZWVlZJykpO1xuXG4gIGRlYnVnKGBmZXRjaGluZyBleHRyYSBzY3JhcCBmb3IgdHJhbnNhY3Rpb24gJHt0cmFuc2FjdGlvbi5pZGVudGlmaWVyfSBmb3IgbW9udGggJHttb250aC5mb3JtYXQoJ1lZWVktTU0nKX1gKTtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkVHJhbnNhY3Rpb25EYXRhPihwYWdlLCB1cmwudG9TdHJpbmcoKSk7XG4gIGlmICghZGF0YSkge1xuICAgIHJldHVybiB0cmFuc2FjdGlvbjtcbiAgfVxuXG4gIGNvbnN0IHJhd0NhdGVnb3J5ID0gXy5nZXQoZGF0YSwgJ1BpcnRleUlza2FfMjA0QmVhbi5zZWN0b3InKSA/PyAnJztcbiAgcmV0dXJuIHtcbiAgICAuLi50cmFuc2FjdGlvbixcbiAgICBjYXRlZ29yeTogcmF3Q2F0ZWdvcnkudHJpbSgpLFxuICAgIHJhd1RyYW5zYWN0aW9uOiBnZXRSYXdUcmFuc2FjdGlvbihkYXRhLCB0cmFuc2FjdGlvbiksXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEV4dHJhU2NyYXBBY2NvdW50KFxuICBwYWdlOiBQYWdlLFxuICBvcHRpb25zOiBDb21wYW55U2VydmljZU9wdGlvbnMsXG4gIGFjY291bnRNYXA6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleCxcbiAgbW9udGg6IG1vbWVudC5Nb21lbnQsXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleD4ge1xuICBjb25zdCBhY2NvdW50czogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W3N0cmluZ11bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGFjY291bnQgb2YgT2JqZWN0LnZhbHVlcyhhY2NvdW50TWFwKSkge1xuICAgIGRlYnVnKFxuICAgICAgYGdldCBleHRyYSBzY3JhcCBmb3IgJHthY2NvdW50LmFjY291bnROdW1iZXJ9IHdpdGggJHthY2NvdW50LnR4bnMubGVuZ3RofSB0cmFuc2FjdGlvbnNgLFxuICAgICAgbW9udGguZm9ybWF0KCdZWVlZLU1NJyksXG4gICAgKTtcbiAgICBjb25zdCB0eG5zOiBUcmFuc2FjdGlvbltdID0gW107XG4gICAgZm9yIChjb25zdCB0eG5zQ2h1bmsgb2YgXy5jaHVuayhhY2NvdW50LnR4bnMsIFJBVEVfTElNSVQuVFJBTlNBQ1RJT05TX0JBVENIX1NJWkUpKSB7XG4gICAgICBkZWJ1ZyhgcHJvY2Vzc2luZyBjaHVuayBvZiAke3R4bnNDaHVuay5sZW5ndGh9IHRyYW5zYWN0aW9ucyBmb3IgYWNjb3VudCAke2FjY291bnQuYWNjb3VudE51bWJlcn1gKTtcbiAgICAgIGNvbnN0IHVwZGF0ZWRUeG5zID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIHR4bnNDaHVuay5tYXAodCA9PiBnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24ocGFnZSwgb3B0aW9ucywgbW9udGgsIGFjY291bnQuaW5kZXgsIHQpKSxcbiAgICAgICk7XG4gICAgICBhd2FpdCBzbGVlcChSQVRFX0xJTUlULlNMRUVQX0JFVFdFRU4pO1xuICAgICAgdHhucy5wdXNoKC4uLnVwZGF0ZWRUeG5zKTtcbiAgICB9XG4gICAgYWNjb3VudHMucHVzaCh7IC4uLmFjY291bnQsIHR4bnMgfSk7XG4gIH1cblxuICByZXR1cm4gYWNjb3VudHMucmVkdWNlKChtLCB4KSA9PiAoeyAuLi5tLCBbeC5hY2NvdW50TnVtYmVyXTogeCB9KSwge30pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbihcbiAgc2NyYXBlck9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBhY2NvdW50c1dpdGhJbmRleDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10sXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgYWxsTW9udGhzOiBtb21lbnQuTW9tZW50W10sXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdPiB7XG4gIGlmIChcbiAgICAhc2NyYXBlck9wdGlvbnMuYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24gfHxcbiAgICBzY3JhcGVyT3B0aW9ucy5vcHRJbkZlYXR1cmVzPy5pbmNsdWRlcygnaXNyYWNhcmQtYW1leDpza2lwQWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24nKVxuICApIHtcbiAgICByZXR1cm4gYWNjb3VudHNXaXRoSW5kZXg7XG4gIH1cbiAgcmV0dXJuIHJ1blNlcmlhbChhY2NvdW50c1dpdGhJbmRleC5tYXAoKGEsIGkpID0+ICgpID0+IGdldEV4dHJhU2NyYXBBY2NvdW50KHBhZ2UsIG9wdGlvbnMsIGEsIGFsbE1vbnRoc1tpXSkpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGxUcmFuc2FjdGlvbnMoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBjb21wYW55U2VydmljZU9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgc3RhcnRNb21lbnQ6IE1vbWVudCxcbikge1xuICBjb25zdCBmdXR1cmVNb250aHNUb1NjcmFwZSA9IG9wdGlvbnMuZnV0dXJlTW9udGhzVG9TY3JhcGUgPz8gMTtcbiAgY29uc3QgYWxsTW9udGhzID0gZ2V0QWxsTW9udGhNb21lbnRzKHN0YXJ0TW9tZW50LCBmdXR1cmVNb250aHNUb1NjcmFwZSk7XG4gIGNvbnN0IHJlc3VsdHM6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdID0gYXdhaXQgcnVuU2VyaWFsKFxuICAgIGFsbE1vbnRocy5tYXAobW9udGhNb21lbnQgPT4gKCkgPT4ge1xuICAgICAgcmV0dXJuIGZldGNoVHJhbnNhY3Rpb25zKHBhZ2UsIG9wdGlvbnMsIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucywgc3RhcnRNb21lbnQsIG1vbnRoTW9tZW50KTtcbiAgICB9KSxcbiAgKTtcblxuICBjb25zdCBmaW5hbFJlc3VsdCA9IGF3YWl0IGdldEFkZGl0aW9uYWxUcmFuc2FjdGlvbkluZm9ybWF0aW9uKFxuICAgIG9wdGlvbnMsXG4gICAgcmVzdWx0cyxcbiAgICBwYWdlLFxuICAgIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgICBhbGxNb250aHMsXG4gICk7XG4gIGNvbnN0IGNvbWJpbmVkVHhuczogUmVjb3JkPHN0cmluZywgVHJhbnNhY3Rpb25bXT4gPSB7fTtcblxuICBmaW5hbFJlc3VsdC5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgT2JqZWN0LmtleXMocmVzdWx0KS5mb3JFYWNoKGFjY291bnROdW1iZXIgPT4ge1xuICAgICAgbGV0IHR4bnNGb3JBY2NvdW50ID0gY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdO1xuICAgICAgaWYgKCF0eG5zRm9yQWNjb3VudCkge1xuICAgICAgICB0eG5zRm9yQWNjb3VudCA9IFtdO1xuICAgICAgICBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0gPSB0eG5zRm9yQWNjb3VudDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHRvQmVBZGRlZFR4bnMgPSByZXN1bHRbYWNjb3VudE51bWJlcl0udHhucztcbiAgICAgIGNvbWJpbmVkVHhuc1thY2NvdW50TnVtYmVyXS5wdXNoKC4uLnRvQmVBZGRlZFR4bnMpO1xuICAgIH0pO1xuICB9KTtcblxuICBjb25zdCBhY2NvdW50cyA9IE9iamVjdC5rZXlzKGNvbWJpbmVkVHhucykubWFwKGFjY291bnROdW1iZXIgPT4ge1xuICAgIHJldHVybiB7XG4gICAgICBhY2NvdW50TnVtYmVyLFxuICAgICAgdHhuczogY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdLFxuICAgIH07XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBhY2NvdW50cyxcbiAgfTtcbn1cblxudHlwZSBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyA9IHsgaWQ6IHN0cmluZzsgcGFzc3dvcmQ6IHN0cmluZzsgY2FyZDZEaWdpdHM6IHN0cmluZyB9O1xuY2xhc3MgSXNyYWNhcmRBbWV4QmFzZVNjcmFwZXIgZXh0ZW5kcyBCYXNlU2NyYXBlcldpdGhCcm93c2VyPFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzPiB7XG4gIHByaXZhdGUgYmFzZVVybDogc3RyaW5nO1xuXG4gIHByaXZhdGUgY29tcGFueUNvZGU6IHN0cmluZztcblxuICBwcml2YXRlIHNlcnZpY2VzVXJsOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogU2NyYXBlck9wdGlvbnMsIGJhc2VVcmw6IHN0cmluZywgY29tcGFueUNvZGU6IHN0cmluZykge1xuICAgIHN1cGVyKG9wdGlvbnMpO1xuXG4gICAgdGhpcy5iYXNlVXJsID0gYmFzZVVybDtcbiAgICB0aGlzLmNvbXBhbnlDb2RlID0gY29tcGFueUNvZGU7XG4gICAgdGhpcy5zZXJ2aWNlc1VybCA9IGAke2Jhc2VVcmx9L3NlcnZpY2VzL1Byb3h5UmVxdWVzdEhhbmRsZXIuYXNoeGA7XG4gIH1cblxuICBhc3luYyBsb2dpbihjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpOiBQcm9taXNlPFNjcmFwZXJTY3JhcGluZ1Jlc3VsdD4ge1xuICAgIGF3YWl0IG1hc2tIZWFkbGVzc1VzZXJBZ2VudCh0aGlzLnBhZ2UpO1xuXG4gICAgYXdhaXQgdGhpcy5wYWdlLnNldFJlcXVlc3RJbnRlcmNlcHRpb24odHJ1ZSk7XG4gICAgdGhpcy5wYWdlLm9uKCdyZXF1ZXN0JywgcmVxdWVzdCA9PiB7XG4gICAgICBpZiAocmVxdWVzdC51cmwoKS5pbmNsdWRlcygnZGV0ZWN0b3ItZG9tLm1pbi5qcycpKSB7XG4gICAgICAgIGRlYnVnKCdmb3JjZSBhYm9ydCBmb3IgcmVxdWVzdCBkbyBkb3dubG9hZCBkZXRlY3Rvci1kb20ubWluLmpzIHJlc291cmNlJyk7XG4gICAgICAgIHZvaWQgcmVxdWVzdC5hYm9ydCh1bmRlZmluZWQsIGludGVyY2VwdGlvblByaW9yaXRpZXMuYWJvcnQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdm9pZCByZXF1ZXN0LmNvbnRpbnVlKHVuZGVmaW5lZCwgaW50ZXJjZXB0aW9uUHJpb3JpdGllcy5jb250aW51ZSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBOYXZpZ2F0ZSB0byBob21lcGFnZSBmaXJzdCB0byBlc3RhYmxpc2ggc2Vzc2lvblxuICAgIGRlYnVnKCd3YXJtaW5nIHVwIGJyb3dzZXIgd2l0aCBob21lcGFnZScpO1xuICAgIGF3YWl0IHRoaXMubmF2aWdhdGVUbyh0aGlzLmJhc2VVcmwsICdkb21jb250ZW50bG9hZGVkJyk7XG4gICAgYXdhaXQgc2xlZXAoMTAwMCk7XG5cbiAgICBkZWJ1ZygnbmF2aWdhdGluZyB0byBsb2dpbiBwYWdlJyk7XG4gICAgYXdhaXQgdGhpcy5uYXZpZ2F0ZVRvKGAke3RoaXMuYmFzZVVybH0vcGVyc29uYWxhcmVhL0xvZ2luYCk7XG5cbiAgICAvLyBDbGljayBvbiBcIteQ15Ug15vXoNeZ16HXlCDXotedINeh15nXodee15Qg16fXkdeV16LXlFwiIHRvIG9wZW4gdGhlIHBhc3N3b3JkIGxvZ2luIGZvcm1cbiAgICBkZWJ1ZygnY2xpY2tpbmcgb24gcGFzc3dvcmQgbG9naW4gbGluaycpO1xuICAgIGF3YWl0IHRoaXMucGFnZS53YWl0Rm9yU2VsZWN0b3IoJyNmbGlwJywgeyB2aXNpYmxlOiB0cnVlLCB0aW1lb3V0OiAzMDAwMCB9KTtcbiAgICBhd2FpdCB0aGlzLnBhZ2UuY2xpY2soJyNmbGlwJyk7XG4gICAgYXdhaXQgc2xlZXAoMTAwMCk7XG5cbiAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dnaW5nSW4pO1xuXG4gICAgY29uc3QgdmFsaWRhdGVVcmwgPSBgJHt0aGlzLnNlcnZpY2VzVXJsfT9yZXFOYW1lPVZhbGlkYXRlSWREYXRhYDtcbiAgICBjb25zdCB2YWxpZGF0ZVJlcXVlc3QgPSB7XG4gICAgICBpZDogY3JlZGVudGlhbHMuaWQsXG4gICAgICBjYXJkU3VmZml4OiBjcmVkZW50aWFscy5jYXJkNkRpZ2l0cyxcbiAgICAgIGNvdW50cnlDb2RlOiBDT1VOVFJZX0NPREUsXG4gICAgICBpZFR5cGU6IElEX1RZUEUsXG4gICAgICBjaGVja0xldmVsOiAnMScsXG4gICAgICBjb21wYW55Q29kZTogdGhpcy5jb21wYW55Q29kZSxcbiAgICB9O1xuICAgIGRlYnVnKCdsb2dnaW5nIGluIHdpdGggdmFsaWRhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IHZhbGlkYXRlUmVzdWx0ID0gYXdhaXQgZmV0Y2hQb3N0V2l0aGluUGFnZTxTY3JhcGVkTG9naW5WYWxpZGF0aW9uPih0aGlzLnBhZ2UsIHZhbGlkYXRlVXJsLCB2YWxpZGF0ZVJlcXVlc3QpO1xuICAgIGlmIChcbiAgICAgICF2YWxpZGF0ZVJlc3VsdCB8fFxuICAgICAgIXZhbGlkYXRlUmVzdWx0LkhlYWRlciB8fFxuICAgICAgdmFsaWRhdGVSZXN1bHQuSGVhZGVyLlN0YXR1cyAhPT0gJzEnIHx8XG4gICAgICAhdmFsaWRhdGVSZXN1bHQuVmFsaWRhdGVJZERhdGFCZWFuXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3Vua25vd24gZXJyb3IgZHVyaW5nIGxvZ2luJyk7XG4gICAgfVxuXG4gICAgY29uc3QgdmFsaWRhdGVSZXR1cm5Db2RlID0gdmFsaWRhdGVSZXN1bHQuVmFsaWRhdGVJZERhdGFCZWFuLnJldHVybkNvZGU7XG4gICAgZGVidWcoYHVzZXIgdmFsaWRhdGUgd2l0aCByZXR1cm4gY29kZSAnJHt2YWxpZGF0ZVJldHVybkNvZGV9J2ApO1xuICAgIGlmICh2YWxpZGF0ZVJldHVybkNvZGUgPT09ICcxJykge1xuICAgICAgY29uc3QgeyB1c2VyTmFtZSB9ID0gdmFsaWRhdGVSZXN1bHQuVmFsaWRhdGVJZERhdGFCZWFuO1xuXG4gICAgICBjb25zdCBsb2dpblVybCA9IGAke3RoaXMuc2VydmljZXNVcmx9P3JlcU5hbWU9cGVyZm9ybUxvZ29uSWA7XG4gICAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgICBLb2RNaXNodGFtZXNoOiB1c2VyTmFtZSxcbiAgICAgICAgTWlzcGFyWmlodXk6IGNyZWRlbnRpYWxzLmlkLFxuICAgICAgICBTaXNtYTogY3JlZGVudGlhbHMucGFzc3dvcmQsXG4gICAgICAgIGNhcmRTdWZmaXg6IGNyZWRlbnRpYWxzLmNhcmQ2RGlnaXRzLFxuICAgICAgICBjb3VudHJ5Q29kZTogQ09VTlRSWV9DT0RFLFxuICAgICAgICBpZFR5cGU6IElEX1RZUEUsXG4gICAgICB9O1xuICAgICAgZGVidWcoJ3VzZXIgbG9naW4gc3RhcnRlZCcpO1xuICAgICAgY29uc3QgbG9naW5SZXN1bHQgPSBhd2FpdCBmZXRjaFBvc3RXaXRoaW5QYWdlPHsgc3RhdHVzOiBzdHJpbmcgfT4odGhpcy5wYWdlLCBsb2dpblVybCwgcmVxdWVzdCk7XG4gICAgICBkZWJ1ZyhgdXNlciBsb2dpbiB3aXRoIHN0YXR1cyAnJHtsb2dpblJlc3VsdD8uc3RhdHVzfSdgLCBsb2dpblJlc3VsdCk7XG5cbiAgICAgIGlmIChsb2dpblJlc3VsdCAmJiBsb2dpblJlc3VsdC5zdGF0dXMgPT09ICcxJykge1xuICAgICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dpblN1Y2Nlc3MpO1xuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gICAgICB9XG5cbiAgICAgIGlmIChsb2dpblJlc3VsdCAmJiBsb2dpblJlc3VsdC5zdGF0dXMgPT09ICczJykge1xuICAgICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5DaGFuZ2VQYXNzd29yZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5DaGFuZ2VQYXNzd29yZCxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5GYWlsZWQpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuSW52YWxpZFBhc3N3b3JkLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAodmFsaWRhdGVSZXR1cm5Db2RlID09PSAnNCcpIHtcbiAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkNoYW5nZVBhc3N3b3JkKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkNoYW5nZVBhc3N3b3JkLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dpbkZhaWxlZCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5JbnZhbGlkUGFzc3dvcmQsXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoRGF0YSgpIHtcbiAgICBjb25zdCBkZWZhdWx0U3RhcnRNb21lbnQgPSBtb21lbnQoKS5zdWJ0cmFjdCgxLCAneWVhcnMnKTtcbiAgICBjb25zdCBzdGFydERhdGUgPSB0aGlzLm9wdGlvbnMuc3RhcnREYXRlIHx8IGRlZmF1bHRTdGFydE1vbWVudC50b0RhdGUoKTtcbiAgICBjb25zdCBzdGFydE1vbWVudCA9IG1vbWVudC5tYXgoZGVmYXVsdFN0YXJ0TW9tZW50LCBtb21lbnQoc3RhcnREYXRlKSk7XG5cbiAgICByZXR1cm4gZmV0Y2hBbGxUcmFuc2FjdGlvbnMoXG4gICAgICB0aGlzLnBhZ2UsXG4gICAgICB0aGlzLm9wdGlvbnMsXG4gICAgICB7XG4gICAgICAgIHNlcnZpY2VzVXJsOiB0aGlzLnNlcnZpY2VzVXJsLFxuICAgICAgICBjb21wYW55Q29kZTogdGhpcy5jb21wYW55Q29kZSxcbiAgICAgIH0sXG4gICAgICBzdGFydE1vbWVudCxcbiAgICApO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IElzcmFjYXJkQW1leEJhc2VTY3JhcGVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxPQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFFQSxJQUFBRSxVQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyxZQUFBLEdBQUFILE9BQUE7QUFDQSxJQUFBSSxNQUFBLEdBQUFMLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBSyxNQUFBLEdBQUFMLE9BQUE7QUFDQSxJQUFBTSxNQUFBLEdBQUFOLE9BQUE7QUFDQSxJQUFBTyxhQUFBLEdBQUFQLE9BQUE7QUFDQSxJQUFBUSxRQUFBLEdBQUFSLE9BQUE7QUFDQSxJQUFBUyxjQUFBLEdBQUFULE9BQUE7QUFPQSxJQUFBVSx1QkFBQSxHQUFBVixPQUFBO0FBQ0EsSUFBQVcsT0FBQSxHQUFBWCxPQUFBO0FBRUEsSUFBQVksUUFBQSxHQUFBWixPQUFBO0FBQW1GLFNBQUFELHVCQUFBYyxDQUFBLFdBQUFBLENBQUEsSUFBQUEsQ0FBQSxDQUFBQyxVQUFBLEdBQUFELENBQUEsS0FBQUUsT0FBQSxFQUFBRixDQUFBO0FBRW5GLE1BQU1HLFVBQVUsR0FBRztFQUNqQkMsYUFBYSxFQUFFLElBQUk7RUFDbkJDLHVCQUF1QixFQUFF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