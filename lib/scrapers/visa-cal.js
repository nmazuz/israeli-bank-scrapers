"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _moment = _interopRequireDefault(require("moment"));
var _debug = require("../helpers/debug");
var _elementsInteractions = require("../helpers/elements-interactions");
var _fetch = require("../helpers/fetch");
var _navigation = require("../helpers/navigation");
var _storage = require("../helpers/storage");
var _transactions = require("../helpers/transactions");
var _waiting = require("../helpers/waiting");
var _transactions2 = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _lodash = _interopRequireDefault(require("lodash"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const apiHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Origin: 'https://digital-web.cal-online.co.il',
  Referer: 'https://digital-web.cal-online.co.il',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty'
};
const LOGIN_URL = 'https://www.cal-online.co.il/';
const TRANSACTIONS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Transactions/api/transactionsDetails/getCardTransactionsDetails';
const FRAMES_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Frames/api/Frames/GetFrameStatus';
const PENDING_TRANSACTIONS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Transactions/api/approvals/getClearanceRequests';
const SSO_AUTHORIZATION_REQUEST_ENDPOINT = 'https://connect.cal-online.co.il/col-rest/calconnect/authentication/SSO';
const InvalidPasswordMessage = 'שם המשתמש או הסיסמה שהוזנו שגויים';
const debug = (0, _debug.getDebug)('visa-cal');
var TrnTypeCode = /*#__PURE__*/function (TrnTypeCode) {
  TrnTypeCode["regular"] = "5";
  TrnTypeCode["credit"] = "6";
  TrnTypeCode["installments"] = "8";
  TrnTypeCode["standingOrder"] = "9";
  return TrnTypeCode;
}(TrnTypeCode || {});
function isAuthModule(result) {
  return Boolean(result?.auth?.calConnectToken && String(result.auth.calConnectToken).trim());
}
function authModuleOrUndefined(result) {
  return isAuthModule(result) ? result : undefined;
}
function isPending(transaction) {
  return transaction.debCrdDate === undefined; // an arbitrary field that only appears in a completed transaction
}
function isCardTransactionDetails(result) {
  return result.result !== undefined;
}
function isCardPendingTransactionDetails(result) {
  return result.result !== undefined;
}
async function getLoginFrame(page) {
  let frame = null;
  debug('wait until login frame found');
  await (0, _waiting.waitUntil)(() => {
    frame = page.frames().find(f => f.url().includes('connect')) || null;
    return Promise.resolve(!!frame);
  }, 'wait for iframe with login form', 10000, 1000);
  if (!frame) {
    debug('failed to find login frame for 10 seconds');
    throw new Error('failed to extract login iframe');
  }
  return frame;
}
async function hasInvalidPasswordError(page) {
  const frame = await getLoginFrame(page);
  const errorFound = await (0, _elementsInteractions.elementPresentOnPage)(frame, 'div.general-error > div');
  const errorMessage = errorFound ? await (0, _elementsInteractions.pageEval)(frame, 'div.general-error > div', '', item => {
    return item.innerText;
  }) : '';
  return errorMessage === InvalidPasswordMessage;
}
async function hasChangePasswordForm(page) {
  const frame = await getLoginFrame(page);
  const errorFound = await (0, _elementsInteractions.elementPresentOnPage)(frame, '.change-password-subtitle');
  return errorFound;
}
function getPossibleLoginResults() {
  debug('return possible login results');
  const urls = {
    [_baseScraperWithBrowser.LoginResults.Success]: [/dashboard/i],
    [_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async options => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasInvalidPasswordError(page);
    }],
    // [LoginResults.AccountBlocked]: [], // TODO add when reaching this scenario
    [_baseScraperWithBrowser.LoginResults.ChangePassword]: [async options => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasChangePasswordForm(page);
    }]
  };
  return urls;
}
function createLoginFields(credentials) {
  debug('create login fields for username and password');
  return [{
    selector: '[formcontrolname="userName"]',
    value: credentials.username
  }, {
    selector: '[formcontrolname="password"]',
    value: credentials.password
  }];
}
function convertParsedDataToTransactions(data, pendingData, options) {
  const pendingTransactions = pendingData?.result ? pendingData.result.cardsList.flatMap(card => card.authDetalisList) : [];
  const bankAccounts = data.flatMap(monthData => monthData.result.bankAccounts);
  const regularDebitDays = bankAccounts.flatMap(accounts => accounts.debitDates);
  const immediateDebitDays = bankAccounts.flatMap(accounts => accounts.immidiateDebits.debitDays);
  const completedTransactions = [...regularDebitDays, ...immediateDebitDays].flatMap(debitDate => debitDate.transactions);
  const all = [...pendingTransactions, ...completedTransactions];
  return all.map(transaction => {
    const numOfPayments = isPending(transaction) ? transaction.numberOfPayments : transaction.numOfPayments;
    const installments = numOfPayments ? {
      number: isPending(transaction) ? 1 : transaction.curPaymentNum,
      total: numOfPayments
    } : undefined;
    const date = (0, _moment.default)(transaction.trnPurchaseDate);
    const chargedAmount = (isPending(transaction) ? transaction.trnAmt : transaction.amtBeforeConvAndIndex) * -1;
    const originalAmount = transaction.trnAmt * (transaction.trnTypeCode === TrnTypeCode.credit ? 1 : -1);
    const result = {
      identifier: !isPending(transaction) ? transaction.trnIntId : undefined,
      type: [TrnTypeCode.regular, TrnTypeCode.standingOrder].includes(transaction.trnTypeCode) ? _transactions2.TransactionTypes.Normal : _transactions2.TransactionTypes.Installments,
      status: isPending(transaction) ? _transactions2.TransactionStatuses.Pending : _transactions2.TransactionStatuses.Completed,
      date: installments ? date.add(installments.number - 1, 'month').toISOString() : date.toISOString(),
      processedDate: isPending(transaction) ? date.toISOString() : new Date(transaction.debCrdDate).toISOString(),
      originalAmount,
      originalCurrency: transaction.trnCurrencySymbol,
      chargedAmount,
      chargedCurrency: !isPending(transaction) ? transaction.debCrdCurrencySymbol : undefined,
      description: transaction.merchantName,
      memo: transaction.transTypeCommentDetails.toString(),
      category: transaction.branchCodeDesc
    };
    if (installments) {
      result.installments = installments;
    }
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions.getRawTransaction)(transaction);
    }
    return result;
  });
}
class VisaCalScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  authorization = undefined;
  openLoginPopup = async () => {
    debug('open login popup, wait until login button available');
    await (0, _elementsInteractions.waitUntilElementFound)(this.page, '#ccLoginDesktopBtn', true);
    debug('click on the login button');
    await (0, _elementsInteractions.clickButton)(this.page, '#ccLoginDesktopBtn');
    debug('get the frame that holds the login');
    const frame = await getLoginFrame(this.page);
    debug('wait until the password login tab header is available');
    await (0, _elementsInteractions.waitUntilElementFound)(frame, '#regular-login');
    debug('navigate to the password login tab');
    await (0, _elementsInteractions.clickButton)(frame, '#regular-login');
    debug('wait until the password login tab is active');
    await (0, _elementsInteractions.waitUntilElementFound)(frame, 'regular-login');
    return frame;
  };
  async getCards() {
    const initData = await (0, _waiting.waitUntil)(() => (0, _storage.getFromSessionStorage)(this.page, 'init'), 'get init data in session storage', 10000, 1000);
    if (!initData) {
      throw new Error('could not find "init" data in session storage');
    }
    return initData?.result.cards.map(({
      cardUniqueId,
      last4Digits
    }) => ({
      cardUniqueId,
      last4Digits
    }));
  }
  async getAuthorizationHeader() {
    if (!this.authorization) {
      debug('fetching authorization header');
      const authModule = await (0, _waiting.waitUntil)(async () => authModuleOrUndefined(await (0, _storage.getFromSessionStorage)(this.page, 'auth-module')), 'get authorization header with valid token in session storage', 10_000, 50);
      return `CALAuthScheme ${authModule.auth.calConnectToken}`;
    }
    return this.authorization;
  }
  async getXSiteId() {
    /*
      I don't know if the constant below will change in the feature.
      If so, use the next code:
       return this.page.evaluate(() => new Ut().xSiteId);
       To get the classname search for 'xSiteId' in the page source
      class Ut {
        constructor(_e, on, yn) {
            this.store = _e,
            this.config = on,
            this.eventBusService = yn,
            this.xSiteId = "09031987-273E-2311-906C-8AF85B17C8D9",
    */
    return Promise.resolve('09031987-273E-2311-906C-8AF85B17C8D9');
  }
  getLoginOptions(credentials) {
    this.authRequestPromise = this.page.waitForRequest(SSO_AUTHORIZATION_REQUEST_ENDPOINT, {
      timeout: 10_000
    }).catch(e => {
      debug('error while waiting for the token request', e);
      return undefined;
    });
    return {
      loginUrl: `${LOGIN_URL}`,
      fields: createLoginFields(credentials),
      submitButtonSelector: 'button[type="submit"]',
      possibleResults: getPossibleLoginResults(),
      checkReadiness: async () => (0, _elementsInteractions.waitUntilElementFound)(this.page, '#ccLoginDesktopBtn'),
      preAction: this.openLoginPopup,
      postAction: async () => {
        try {
          await (0, _navigation.waitForNavigation)(this.page);
          const currentUrl = await (0, _navigation.getCurrentUrl)(this.page);
          if (currentUrl.endsWith('site-tutorial')) {
            await (0, _elementsInteractions.clickButton)(this.page, 'button.btn-close');
          }
          const request = await this.authRequestPromise;
          this.authorization = String(request?.headers().authorization || '').trim();
        } catch (e) {
          const currentUrl = await (0, _navigation.getCurrentUrl)(this.page);
          if (currentUrl.endsWith('dashboard')) return;
          const requiresChangePassword = await hasChangePasswordForm(this.page);
          if (requiresChangePassword) return;
          throw e;
        }
      },
      userAgent: apiHeaders['User-Agent']
    };
  }
  async fetchData() {
    const defaultStartMoment = (0, _moment.default)().subtract(1, 'years').subtract(6, 'months').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
    debug(`fetch transactions starting ${startMoment.format()}`);
    const [cards, xSiteId, Authorization] = await Promise.all([this.getCards(), this.getXSiteId(), this.getAuthorizationHeader()]);
    const futureMonthsToScrape = this.options.futureMonthsToScrape ?? 1;
    debug('fetch frames (misgarot) of cards');
    const frames = await (0, _fetch.fetchPost)(FRAMES_REQUEST_ENDPOINT, {
      cardsForFrameData: cards.map(({
        cardUniqueId
      }) => ({
        cardUniqueId
      }))
    }, {
      Authorization,
      'X-Site-Id': xSiteId,
      'Content-Type': 'application/json',
      ...apiHeaders
    });
    const accounts = await Promise.all(cards.map(async card => {
      const finalMonthToFetchMoment = (0, _moment.default)().add(futureMonthsToScrape, 'month');
      const months = finalMonthToFetchMoment.diff(startMoment, 'months');
      const allMonthsData = [];
      const frame = _lodash.default.find(frames.result?.bankIssuedCards?.cardLevelFrames, {
        cardUniqueId: card.cardUniqueId
      });
      debug(`fetch pending transactions for card ${card.cardUniqueId}`);
      let pendingData = await (0, _fetch.fetchPost)(PENDING_TRANSACTIONS_REQUEST_ENDPOINT, {
        cardUniqueIDArray: [card.cardUniqueId]
      }, {
        Authorization,
        'X-Site-Id': xSiteId,
        'Content-Type': 'application/json',
        ...apiHeaders
      });
      debug(`fetch completed transactions for card ${card.cardUniqueId}`);
      for (let i = 0; i <= months; i++) {
        const month = finalMonthToFetchMoment.clone().subtract(i, 'months');
        const monthData = await (0, _fetch.fetchPost)(TRANSACTIONS_REQUEST_ENDPOINT, {
          cardUniqueId: card.cardUniqueId,
          month: month.format('M'),
          year: month.format('YYYY')
        }, {
          Authorization,
          'X-Site-Id': xSiteId,
          'Content-Type': 'application/json',
          ...apiHeaders
        });
        if (monthData?.statusCode !== 1) throw new Error(`failed to fetch transactions for card ${card.last4Digits}. Message: ${monthData?.title || ''}`);
        if (!isCardTransactionDetails(monthData)) {
          throw new Error('monthData is not of type CardTransactionDetails');
        }
        allMonthsData.push(monthData);
      }
      if (pendingData?.statusCode !== 1 && pendingData?.statusCode !== 96) {
        debug(`failed to fetch pending transactions for card ${card.last4Digits}. Message: ${pendingData?.title || ''}`);
        pendingData = null;
      } else if (!isCardPendingTransactionDetails(pendingData)) {
        debug('pendingData is not of type CardTransactionDetails');
        pendingData = null;
      }
      const transactions = convertParsedDataToTransactions(allMonthsData, pendingData, this.options);
      debug('filter out old transactions');
      const txns = this.options.outputData?.enableTransactionsFilterByDate ?? true ? (0, _transactions.filterOldTransactions)(transactions, (0, _moment.default)(startDate), this.options.combineInstallments || false) : transactions;
      return {
        txns,
        balance: frame?.nextTotalDebit != null ? -frame.nextTotalDebit : undefined,
        accountNumber: card.last4Digits
      };
    }));
    debug('return the scraped accounts');
    debug(JSON.stringify(accounts, null, 2));
    return {
      success: true,
      accounts
    };
  }
}
var _default = exports.default = VisaCalScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfZGVidWciLCJfZWxlbWVudHNJbnRlcmFjdGlvbnMiLCJfZmV0Y2giLCJfbmF2aWdhdGlvbiIsIl9zdG9yYWdlIiwiX3RyYW5zYWN0aW9ucyIsIl93YWl0aW5nIiwiX3RyYW5zYWN0aW9uczIiLCJfYmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsIl9sb2Rhc2giLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJhcGlIZWFkZXJzIiwiT3JpZ2luIiwiUmVmZXJlciIsIkxPR0lOX1VSTCIsIlRSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5UIiwiRlJBTUVTX1JFUVVFU1RfRU5EUE9JTlQiLCJQRU5ESU5HX1RSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5UIiwiU1NPX0FVVEhPUklaQVRJT05fUkVRVUVTVF9FTkRQT0lOVCIsIkludmFsaWRQYXNzd29yZE1lc3NhZ2UiLCJkZWJ1ZyIsImdldERlYnVnIiwiVHJuVHlwZUNvZGUiLCJpc0F1dGhNb2R1bGUiLCJyZXN1bHQiLCJCb29sZWFuIiwiYXV0aCIsImNhbENvbm5lY3RUb2tlbiIsIlN0cmluZyIsInRyaW0iLCJhdXRoTW9kdWxlT3JVbmRlZmluZWQiLCJ1bmRlZmluZWQiLCJpc1BlbmRpbmciLCJ0cmFuc2FjdGlvbiIsImRlYkNyZERhdGUiLCJpc0NhcmRUcmFuc2FjdGlvbkRldGFpbHMiLCJpc0NhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzIiwiZ2V0TG9naW5GcmFtZSIsInBhZ2UiLCJmcmFtZSIsIndhaXRVbnRpbCIsImZyYW1lcyIsImZpbmQiLCJmIiwidXJsIiwiaW5jbHVkZXMiLCJQcm9taXNlIiwicmVzb2x2ZSIsIkVycm9yIiwiaGFzSW52YWxpZFBhc3N3b3JkRXJyb3IiLCJlcnJvckZvdW5kIiwiZWxlbWVudFByZXNlbnRPblBhZ2UiLCJlcnJvck1lc3NhZ2UiLCJwYWdlRXZhbCIsIml0ZW0iLCJpbm5lclRleHQiLCJoYXNDaGFuZ2VQYXNzd29yZEZvcm0iLCJnZXRQb3NzaWJsZUxvZ2luUmVzdWx0cyIsInVybHMiLCJMb2dpblJlc3VsdHMiLCJTdWNjZXNzIiwiSW52YWxpZFBhc3N3b3JkIiwib3B0aW9ucyIsIkNoYW5nZVBhc3N3b3JkIiwiY3JlYXRlTG9naW5GaWVsZHMiLCJjcmVkZW50aWFscyIsInNlbGVjdG9yIiwidmFsdWUiLCJ1c2VybmFtZSIsInBhc3N3b3JkIiwiY29udmVydFBhcnNlZERhdGFUb1RyYW5zYWN0aW9ucyIsImRhdGEiLCJwZW5kaW5nRGF0YSIsInBlbmRpbmdUcmFuc2FjdGlvbnMiLCJjYXJkc0xpc3QiLCJmbGF0TWFwIiwiY2FyZCIsImF1dGhEZXRhbGlzTGlzdCIsImJhbmtBY2NvdW50cyIsIm1vbnRoRGF0YSIsInJlZ3VsYXJEZWJpdERheXMiLCJhY2NvdW50cyIsImRlYml0RGF0ZXMiLCJpbW1lZGlhdGVEZWJpdERheXMiLCJpbW1pZGlhdGVEZWJpdHMiLCJkZWJpdERheXMiLCJjb21wbGV0ZWRUcmFuc2FjdGlvbnMiLCJkZWJpdERhdGUiLCJ0cmFuc2FjdGlvbnMiLCJhbGwiLCJtYXAiLCJudW1PZlBheW1lbnRzIiwibnVtYmVyT2ZQYXltZW50cyIsImluc3RhbGxtZW50cyIsIm51bWJlciIsImN1clBheW1lbnROdW0iLCJ0b3RhbCIsImRhdGUiLCJtb21lbnQiLCJ0cm5QdXJjaGFzZURhdGUiLCJjaGFyZ2VkQW1vdW50IiwidHJuQW10IiwiYW10QmVmb3JlQ29udkFuZEluZGV4Iiwib3JpZ2luYWxBbW91bnQiLCJ0cm5UeXBlQ29kZSIsImNyZWRpdCIsImlkZW50aWZpZXIiLCJ0cm5JbnRJZCIsInR5cGUiLCJyZWd1bGFyIiwic3RhbmRpbmdPcmRlciIsIlRyYW5zYWN0aW9uVHlwZXMiLCJOb3JtYWwiLCJJbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiUGVuZGluZyIsIkNvbXBsZXRlZCIsImFkZCIsInRvSVNPU3RyaW5nIiwicHJvY2Vzc2VkRGF0ZSIsIkRhdGUiLCJvcmlnaW5hbEN1cnJlbmN5IiwidHJuQ3VycmVuY3lTeW1ib2wiLCJjaGFyZ2VkQ3VycmVuY3kiLCJkZWJDcmRDdXJyZW5jeVN5bWJvbCIsImRlc2NyaXB0aW9uIiwibWVyY2hhbnROYW1lIiwibWVtbyIsInRyYW5zVHlwZUNvbW1lbnREZXRhaWxzIiwidG9TdHJpbmciLCJjYXRlZ29yeSIsImJyYW5jaENvZGVEZXNjIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsIlZpc2FDYWxTY3JhcGVyIiwiQmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImF1dGhvcml6YXRpb24iLCJvcGVuTG9naW5Qb3B1cCIsIndhaXRVbnRpbEVsZW1lbnRGb3VuZCIsImNsaWNrQnV0dG9uIiwiZ2V0Q2FyZHMiLCJpbml0RGF0YSIsImdldEZyb21TZXNzaW9uU3RvcmFnZSIsImNhcmRzIiwiY2FyZFVuaXF1ZUlkIiwibGFzdDREaWdpdHMiLCJnZXRBdXRob3JpemF0aW9uSGVhZGVyIiwiYXV0aE1vZHVsZSIsImdldFhTaXRlSWQiLCJnZXRMb2dpbk9wdGlvbnMiLCJhdXRoUmVxdWVzdFByb21pc2UiLCJ3YWl0Rm9yUmVxdWVzdCIsInRpbWVvdXQiLCJjYXRjaCIsImxvZ2luVXJsIiwiZmllbGRzIiwic3VibWl0QnV0dG9uU2VsZWN0b3IiLCJwb3NzaWJsZVJlc3VsdHMiLCJjaGVja1JlYWRpbmVzcyIsInByZUFjdGlvbiIsInBvc3RBY3Rpb24iLCJ3YWl0Rm9yTmF2aWdhdGlvbiIsImN1cnJlbnRVcmwiLCJnZXRDdXJyZW50VXJsIiwiZW5kc1dpdGgiLCJyZXF1ZXN0IiwiaGVhZGVycyIsInJlcXVpcmVzQ2hhbmdlUGFzc3dvcmQiLCJ1c2VyQWdlbnQiLCJmZXRjaERhdGEiLCJkZWZhdWx0U3RhcnRNb21lbnQiLCJzdWJ0cmFjdCIsInN0YXJ0RGF0ZSIsInRvRGF0ZSIsInN0YXJ0TW9tZW50IiwibWF4IiwiZm9ybWF0IiwieFNpdGVJZCIsIkF1dGhvcml6YXRpb24iLCJmdXR1cmVNb250aHNUb1NjcmFwZSIsImZldGNoUG9zdCIsImNhcmRzRm9yRnJhbWVEYXRhIiwiZmluYWxNb250aFRvRmV0Y2hNb21lbnQiLCJtb250aHMiLCJkaWZmIiwiYWxsTW9udGhzRGF0YSIsIl8iLCJiYW5rSXNzdWVkQ2FyZHMiLCJjYXJkTGV2ZWxGcmFtZXMiLCJjYXJkVW5pcXVlSURBcnJheSIsImkiLCJtb250aCIsImNsb25lIiwieWVhciIsInN0YXR1c0NvZGUiLCJ0aXRsZSIsInB1c2giLCJ0eG5zIiwib3V0cHV0RGF0YSIsImVuYWJsZVRyYW5zYWN0aW9uc0ZpbHRlckJ5RGF0ZSIsImZpbHRlck9sZFRyYW5zYWN0aW9ucyIsImNvbWJpbmVJbnN0YWxsbWVudHMiLCJiYWxhbmNlIiwibmV4dFRvdGFsRGViaXQiLCJhY2NvdW50TnVtYmVyIiwiSlNPTiIsInN0cmluZ2lmeSIsInN1Y2Nlc3MiLCJfZGVmYXVsdCIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvc2NyYXBlcnMvdmlzYS1jYWwudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IG1vbWVudCBmcm9tICdtb21lbnQnO1xuaW1wb3J0IHsgdHlwZSBIVFRQUmVxdWVzdCwgdHlwZSBGcmFtZSwgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcbmltcG9ydCB7IGdldERlYnVnIH0gZnJvbSAnLi4vaGVscGVycy9kZWJ1Zyc7XG5pbXBvcnQgeyBjbGlja0J1dHRvbiwgZWxlbWVudFByZXNlbnRPblBhZ2UsIHBhZ2VFdmFsLCB3YWl0VW50aWxFbGVtZW50Rm91bmQgfSBmcm9tICcuLi9oZWxwZXJzL2VsZW1lbnRzLWludGVyYWN0aW9ucyc7XG5pbXBvcnQgeyBmZXRjaFBvc3QgfSBmcm9tICcuLi9oZWxwZXJzL2ZldGNoJztcbmltcG9ydCB7IGdldEN1cnJlbnRVcmwsIHdhaXRGb3JOYXZpZ2F0aW9uIH0gZnJvbSAnLi4vaGVscGVycy9uYXZpZ2F0aW9uJztcbmltcG9ydCB7IGdldEZyb21TZXNzaW9uU3RvcmFnZSB9IGZyb20gJy4uL2hlbHBlcnMvc3RvcmFnZSc7XG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGdldFJhd1RyYW5zYWN0aW9uIH0gZnJvbSAnLi4vaGVscGVycy90cmFuc2FjdGlvbnMnO1xuaW1wb3J0IHsgd2FpdFVudGlsIH0gZnJvbSAnLi4vaGVscGVycy93YWl0aW5nJztcbmltcG9ydCB7IFRyYW5zYWN0aW9uU3RhdHVzZXMsIFRyYW5zYWN0aW9uVHlwZXMsIHR5cGUgVHJhbnNhY3Rpb24sIHR5cGUgVHJhbnNhY3Rpb25zQWNjb3VudCB9IGZyb20gJy4uL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBCYXNlU2NyYXBlcldpdGhCcm93c2VyLCBMb2dpblJlc3VsdHMsIHR5cGUgTG9naW5PcHRpb25zIH0gZnJvbSAnLi9iYXNlLXNjcmFwZXItd2l0aC1icm93c2VyJztcbmltcG9ydCB7IHR5cGUgU2NyYXBlclNjcmFwaW5nUmVzdWx0LCB0eXBlIFNjcmFwZXJPcHRpb25zIH0gZnJvbSAnLi9pbnRlcmZhY2UnO1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcblxuY29uc3QgYXBpSGVhZGVycyA9IHtcbiAgJ1VzZXItQWdlbnQnOlxuICAgICdNb3ppbGxhLzUuMCAoTWFjaW50b3NoOyBJbnRlbCBNYWMgT1MgWCAxMF8xNV83KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUvMTQyLjAuMC4wIFNhZmFyaS81MzcuMzYnLFxuICBPcmlnaW46ICdodHRwczovL2RpZ2l0YWwtd2ViLmNhbC1vbmxpbmUuY28uaWwnLFxuICBSZWZlcmVyOiAnaHR0cHM6Ly9kaWdpdGFsLXdlYi5jYWwtb25saW5lLmNvLmlsJyxcbiAgJ0FjY2VwdC1MYW5ndWFnZSc6ICdoZS1JTCxoZTtxPTAuOSxlbi1VUztxPTAuOCxlbjtxPTAuNycsXG4gICdTZWMtRmV0Y2gtU2l0ZSc6ICdzYW1lLXNpdGUnLFxuICAnU2VjLUZldGNoLU1vZGUnOiAnY29ycycsXG4gICdTZWMtRmV0Y2gtRGVzdCc6ICdlbXB0eScsXG59O1xuY29uc3QgTE9HSU5fVVJMID0gJ2h0dHBzOi8vd3d3LmNhbC1vbmxpbmUuY28uaWwvJztcbmNvbnN0IFRSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5UID1cbiAgJ2h0dHBzOi8vYXBpLmNhbC1vbmxpbmUuY28uaWwvVHJhbnNhY3Rpb25zL2FwaS90cmFuc2FjdGlvbnNEZXRhaWxzL2dldENhcmRUcmFuc2FjdGlvbnNEZXRhaWxzJztcbmNvbnN0IEZSQU1FU19SRVFVRVNUX0VORFBPSU5UID0gJ2h0dHBzOi8vYXBpLmNhbC1vbmxpbmUuY28uaWwvRnJhbWVzL2FwaS9GcmFtZXMvR2V0RnJhbWVTdGF0dXMnO1xuY29uc3QgUEVORElOR19UUkFOU0FDVElPTlNfUkVRVUVTVF9FTkRQT0lOVCA9XG4gICdodHRwczovL2FwaS5jYWwtb25saW5lLmNvLmlsL1RyYW5zYWN0aW9ucy9hcGkvYXBwcm92YWxzL2dldENsZWFyYW5jZVJlcXVlc3RzJztcbmNvbnN0IFNTT19BVVRIT1JJWkFUSU9OX1JFUVVFU1RfRU5EUE9JTlQgPSAnaHR0cHM6Ly9jb25uZWN0LmNhbC1vbmxpbmUuY28uaWwvY29sLXJlc3QvY2FsY29ubmVjdC9hdXRoZW50aWNhdGlvbi9TU08nO1xuXG5jb25zdCBJbnZhbGlkUGFzc3dvcmRNZXNzYWdlID0gJ9ep150g15TXntep16rXntepINeQ15Ug15TXodeZ16HXnteUINep15TXldeW16DXlSDXqdeS15XXmdeZ150nO1xuXG5jb25zdCBkZWJ1ZyA9IGdldERlYnVnKCd2aXNhLWNhbCcpO1xuXG5lbnVtIFRyblR5cGVDb2RlIHtcbiAgcmVndWxhciA9ICc1JyxcbiAgY3JlZGl0ID0gJzYnLFxuICBpbnN0YWxsbWVudHMgPSAnOCcsXG4gIHN0YW5kaW5nT3JkZXIgPSAnOScsXG59XG5cbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb24ge1xuICBhbXRCZWZvcmVDb252QW5kSW5kZXg6IG51bWJlcjtcbiAgYnJhbmNoQ29kZURlc2M6IHN0cmluZztcbiAgY2FzaEFjY01hbmFnZXJOYW1lOiBudWxsO1xuICBjYXNoQWNjb3VudE1hbmFnZXI6IG51bGw7XG4gIGNhc2hBY2NvdW50VHJuQW10OiBudW1iZXI7XG4gIGNoYXJnZUV4dGVybmFsVG9DYXJkQ29tbWVudDogc3RyaW5nO1xuICBjb21tZW50czogW107XG4gIGN1clBheW1lbnROdW06IG51bWJlcjtcbiAgZGViQ3JkQ3VycmVuY3lTeW1ib2w6IEN1cnJlbmN5U3ltYm9sO1xuICBkZWJDcmREYXRlOiBzdHJpbmc7XG4gIGRlYml0U3ByZWFkSW5kOiBib29sZWFuO1xuICBkaXNjb3VudEFtb3VudDogdW5rbm93bjtcbiAgZGlzY291bnRSZWFzb246IHVua25vd247XG4gIGltbWVkaWF0ZUNvbW1lbnRzOiBbXTtcbiAgaXNJbW1lZGlhdGVDb21tZW50SW5kOiBib29sZWFuO1xuICBpc0ltbWVkaWF0ZUhIS0luZDogYm9vbGVhbjtcbiAgaXNNYXJnYXJpdGE6IGJvb2xlYW47XG4gIGlzU3ByZWFkUGF5bWVuc3RBYnJvYWQ6IGJvb2xlYW47XG4gIGxpbmtlZENvbW1lbnRzOiBbXTtcbiAgbWVyY2hhbnRBZGRyZXNzOiBzdHJpbmc7XG4gIG1lcmNoYW50TmFtZTogc3RyaW5nO1xuICBtZXJjaGFudFBob25lTm86IHN0cmluZztcbiAgbnVtT2ZQYXltZW50czogbnVtYmVyO1xuICBvbkdvaW5nVHJhbnNhY3Rpb25zQ29tbWVudDogc3RyaW5nO1xuICByZWZ1bmRJbmQ6IGJvb2xlYW47XG4gIHJvdW5kaW5nQW1vdW50OiB1bmtub3duO1xuICByb3VuZGluZ1JlYXNvbjogdW5rbm93bjtcbiAgdG9rZW5JbmQ6IDA7XG4gIHRva2VuTnVtYmVyUGFydDQ6ICcnO1xuICB0cmFuc0NhcmRQcmVzZW50SW5kOiBib29sZWFuO1xuICB0cmFuc1R5cGVDb21tZW50RGV0YWlsczogW107XG4gIHRybkFtdDogbnVtYmVyO1xuICB0cm5DdXJyZW5jeVN5bWJvbDogQ3VycmVuY3lTeW1ib2w7XG4gIHRybkV4YWNXYXk6IG51bWJlcjtcbiAgdHJuSW50SWQ6IHN0cmluZztcbiAgdHJuTnVtYXJldG9yOiBudW1iZXI7XG4gIHRyblB1cmNoYXNlRGF0ZTogc3RyaW5nO1xuICB0cm5UeXBlOiBzdHJpbmc7XG4gIHRyblR5cGVDb2RlOiBUcm5UeXBlQ29kZTtcbiAgd2FsbGV0UHJvdmlkZXJDb2RlOiAwO1xuICB3YWxsZXRQcm92aWRlckRlc2M6ICcnO1xuICBlYXJseVBheW1lbnRJbmQ6IGJvb2xlYW47XG59XG5pbnRlcmZhY2UgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbiB7XG4gIG1lcmNoYW50SUQ6IHN0cmluZztcbiAgbWVyY2hhbnROYW1lOiBzdHJpbmc7XG4gIHRyblB1cmNoYXNlRGF0ZTogc3RyaW5nO1xuICB3YWxsZXRUcmFuSW5kOiBudW1iZXI7XG4gIHRyYW5zYWN0aW9uc09yaWdpbjogbnVtYmVyO1xuICB0cm5BbXQ6IG51bWJlcjtcbiAgdHBhQXBwcm92YWxBbW91bnQ6IHVua25vd247XG4gIHRybkN1cnJlbmN5U3ltYm9sOiBDdXJyZW5jeVN5bWJvbDtcbiAgdHJuVHlwZUNvZGU6IFRyblR5cGVDb2RlO1xuICB0cm5UeXBlOiBzdHJpbmc7XG4gIGJyYW5jaENvZGVEZXNjOiBzdHJpbmc7XG4gIHRyYW5zQ2FyZFByZXNlbnRJbmQ6IGJvb2xlYW47XG4gIGo1SW5kaWNhdG9yOiBzdHJpbmc7XG4gIG51bWJlck9mUGF5bWVudHM6IG51bWJlcjtcbiAgZmlyc3RQYXltZW50QW1vdW50OiBudW1iZXI7XG4gIHRyYW5zVHlwZUNvbW1lbnREZXRhaWxzOiBbXTtcbn1cbmludGVyZmFjZSBJbml0UmVzcG9uc2Uge1xuICByZXN1bHQ6IHtcbiAgICBjYXJkczoge1xuICAgICAgY2FyZFVuaXF1ZUlkOiBzdHJpbmc7XG4gICAgICBsYXN0NERpZ2l0czogc3RyaW5nO1xuICAgICAgW2tleTogc3RyaW5nXTogdW5rbm93bjtcbiAgICB9W107XG4gIH07XG59XG50eXBlIEN1cnJlbmN5U3ltYm9sID0gc3RyaW5nO1xuaW50ZXJmYWNlIENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvciB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHN0YXR1c0NvZGU6IG51bWJlcjtcbn1cbmludGVyZmFjZSBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzIGV4dGVuZHMgQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc0Vycm9yIHtcbiAgcmVzdWx0OiB7XG4gICAgYmFua0FjY291bnRzOiB7XG4gICAgICBiYW5rQWNjb3VudE51bTogc3RyaW5nO1xuICAgICAgYmFua05hbWU6IHN0cmluZztcbiAgICAgIGNob2ljZUV4dGVybmFsVHJhbnNhY3Rpb25zOiBhbnk7XG4gICAgICBjdXJyZW50QmFua0FjY291bnRJbmQ6IGJvb2xlYW47XG4gICAgICBkZWJpdERhdGVzOiB7XG4gICAgICAgIGJhc2tldEFtb3VudENvbW1lbnQ6IHVua25vd247XG4gICAgICAgIGNob2ljZUhIS0RlYml0OiBudW1iZXI7XG4gICAgICAgIGRhdGU6IHN0cmluZztcbiAgICAgICAgZGViaXRSZWFzb246IHVua25vd247XG4gICAgICAgIGZpeERlYml0QW1vdW50OiBudW1iZXI7XG4gICAgICAgIGZyb21QdXJjaGFzZURhdGU6IHN0cmluZztcbiAgICAgICAgaXNDaG9pY2VSZXBhaW1lbnQ6IGJvb2xlYW47XG4gICAgICAgIHRvUHVyY2hhc2VEYXRlOiBzdHJpbmc7XG4gICAgICAgIHRvdGFsQmFza2V0QW1vdW50OiBudW1iZXI7XG4gICAgICAgIHRvdGFsRGViaXRzOiB7XG4gICAgICAgICAgY3VycmVuY3lTeW1ib2w6IEN1cnJlbmN5U3ltYm9sO1xuICAgICAgICAgIGFtb3VudDogbnVtYmVyO1xuICAgICAgICB9W107XG4gICAgICAgIHRyYW5zYWN0aW9uczogU2NyYXBlZFRyYW5zYWN0aW9uW107XG4gICAgICB9W107XG4gICAgICBpbW1pZGlhdGVEZWJpdHM6IHsgdG90YWxEZWJpdHM6IFtdOyBkZWJpdERheXM6IFtdIH07XG4gICAgfVtdO1xuICAgIGJsb2NrZWRDYXJkSW5kOiBib29sZWFuO1xuICB9O1xuICBzdGF0dXNDb2RlOiAxO1xuICBzdGF0dXNEZXNjcmlwdGlvbjogc3RyaW5nO1xuICBzdGF0dXNUaXRsZTogc3RyaW5nO1xufVxuaW50ZXJmYWNlIENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzIGV4dGVuZHMgQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc0Vycm9yIHtcbiAgcmVzdWx0OiB7XG4gICAgY2FyZHNMaXN0OiB7XG4gICAgICBjYXJkVW5pcXVlSUQ6IHN0cmluZztcbiAgICAgIGF1dGhEZXRhbGlzTGlzdDogU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbltdO1xuICAgIH1bXTtcbiAgfTtcbiAgc3RhdHVzQ29kZTogMTtcbiAgc3RhdHVzRGVzY3JpcHRpb246IHN0cmluZztcbiAgc3RhdHVzVGl0bGU6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENhcmRMZXZlbEZyYW1lIHtcbiAgY2FyZFVuaXF1ZUlkOiBzdHJpbmc7XG4gIG5leHRUb3RhbERlYml0PzogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgRnJhbWVzUmVzcG9uc2Uge1xuICByZXN1bHQ/OiB7XG4gICAgYmFua0lzc3VlZENhcmRzPzoge1xuICAgICAgY2FyZExldmVsRnJhbWVzPzogQ2FyZExldmVsRnJhbWVbXTtcbiAgICB9O1xuICB9O1xufVxuXG5pbnRlcmZhY2UgQXV0aE1vZHVsZSB7XG4gIGF1dGg6IHtcbiAgICBjYWxDb25uZWN0VG9rZW46IHN0cmluZyB8IG51bGw7XG4gIH07XG59XG5cbmZ1bmN0aW9uIGlzQXV0aE1vZHVsZShyZXN1bHQ6IGFueSk6IHJlc3VsdCBpcyBBdXRoTW9kdWxlIHtcbiAgcmV0dXJuIEJvb2xlYW4ocmVzdWx0Py5hdXRoPy5jYWxDb25uZWN0VG9rZW4gJiYgU3RyaW5nKHJlc3VsdC5hdXRoLmNhbENvbm5lY3RUb2tlbikudHJpbSgpKTtcbn1cblxuZnVuY3Rpb24gYXV0aE1vZHVsZU9yVW5kZWZpbmVkKHJlc3VsdDogYW55KTogQXV0aE1vZHVsZSB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBpc0F1dGhNb2R1bGUocmVzdWx0KSA/IHJlc3VsdCA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gaXNQZW5kaW5nKFxuICB0cmFuc2FjdGlvbjogU2NyYXBlZFRyYW5zYWN0aW9uIHwgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbixcbik6IHRyYW5zYWN0aW9uIGlzIFNjcmFwZWRQZW5kaW5nVHJhbnNhY3Rpb24ge1xuICByZXR1cm4gKHRyYW5zYWN0aW9uIGFzIFNjcmFwZWRUcmFuc2FjdGlvbikuZGViQ3JkRGF0ZSA9PT0gdW5kZWZpbmVkOyAvLyBhbiBhcmJpdHJhcnkgZmllbGQgdGhhdCBvbmx5IGFwcGVhcnMgaW4gYSBjb21wbGV0ZWQgdHJhbnNhY3Rpb25cbn1cblxuZnVuY3Rpb24gaXNDYXJkVHJhbnNhY3Rpb25EZXRhaWxzKFxuICByZXN1bHQ6IENhcmRUcmFuc2FjdGlvbkRldGFpbHMgfCBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3IsXG4pOiByZXN1bHQgaXMgQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyB7XG4gIHJldHVybiAocmVzdWx0IGFzIENhcmRUcmFuc2FjdGlvbkRldGFpbHMpLnJlc3VsdCAhPT0gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBpc0NhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzKFxuICByZXN1bHQ6IENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzIHwgQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc0Vycm9yLFxuKTogcmVzdWx0IGlzIENhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzIHtcbiAgcmV0dXJuIChyZXN1bHQgYXMgQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMpLnJlc3VsdCAhPT0gdW5kZWZpbmVkO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRMb2dpbkZyYW1lKHBhZ2U6IFBhZ2UpIHtcbiAgbGV0IGZyYW1lOiBGcmFtZSB8IG51bGwgPSBudWxsO1xuICBkZWJ1Zygnd2FpdCB1bnRpbCBsb2dpbiBmcmFtZSBmb3VuZCcpO1xuICBhd2FpdCB3YWl0VW50aWwoXG4gICAgKCkgPT4ge1xuICAgICAgZnJhbWUgPSBwYWdlLmZyYW1lcygpLmZpbmQoZiA9PiBmLnVybCgpLmluY2x1ZGVzKCdjb25uZWN0JykpIHx8IG51bGw7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCEhZnJhbWUpO1xuICAgIH0sXG4gICAgJ3dhaXQgZm9yIGlmcmFtZSB3aXRoIGxvZ2luIGZvcm0nLFxuICAgIDEwMDAwLFxuICAgIDEwMDAsXG4gICk7XG5cbiAgaWYgKCFmcmFtZSkge1xuICAgIGRlYnVnKCdmYWlsZWQgdG8gZmluZCBsb2dpbiBmcmFtZSBmb3IgMTAgc2Vjb25kcycpO1xuICAgIHRocm93IG5ldyBFcnJvcignZmFpbGVkIHRvIGV4dHJhY3QgbG9naW4gaWZyYW1lJyk7XG4gIH1cblxuICByZXR1cm4gZnJhbWU7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhc0ludmFsaWRQYXNzd29yZEVycm9yKHBhZ2U6IFBhZ2UpIHtcbiAgY29uc3QgZnJhbWUgPSBhd2FpdCBnZXRMb2dpbkZyYW1lKHBhZ2UpO1xuICBjb25zdCBlcnJvckZvdW5kID0gYXdhaXQgZWxlbWVudFByZXNlbnRPblBhZ2UoZnJhbWUsICdkaXYuZ2VuZXJhbC1lcnJvciA+IGRpdicpO1xuICBjb25zdCBlcnJvck1lc3NhZ2UgPSBlcnJvckZvdW5kXG4gICAgPyBhd2FpdCBwYWdlRXZhbChmcmFtZSwgJ2Rpdi5nZW5lcmFsLWVycm9yID4gZGl2JywgJycsIGl0ZW0gPT4ge1xuICAgICAgICByZXR1cm4gKGl0ZW0gYXMgSFRNTERpdkVsZW1lbnQpLmlubmVyVGV4dDtcbiAgICAgIH0pXG4gICAgOiAnJztcbiAgcmV0dXJuIGVycm9yTWVzc2FnZSA9PT0gSW52YWxpZFBhc3N3b3JkTWVzc2FnZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFzQ2hhbmdlUGFzc3dvcmRGb3JtKHBhZ2U6IFBhZ2UpIHtcbiAgY29uc3QgZnJhbWUgPSBhd2FpdCBnZXRMb2dpbkZyYW1lKHBhZ2UpO1xuICBjb25zdCBlcnJvckZvdW5kID0gYXdhaXQgZWxlbWVudFByZXNlbnRPblBhZ2UoZnJhbWUsICcuY2hhbmdlLXBhc3N3b3JkLXN1YnRpdGxlJyk7XG4gIHJldHVybiBlcnJvckZvdW5kO1xufVxuXG5mdW5jdGlvbiBnZXRQb3NzaWJsZUxvZ2luUmVzdWx0cygpIHtcbiAgZGVidWcoJ3JldHVybiBwb3NzaWJsZSBsb2dpbiByZXN1bHRzJyk7XG4gIGNvbnN0IHVybHM6IExvZ2luT3B0aW9uc1sncG9zc2libGVSZXN1bHRzJ10gPSB7XG4gICAgW0xvZ2luUmVzdWx0cy5TdWNjZXNzXTogWy9kYXNoYm9hcmQvaV0sXG4gICAgW0xvZ2luUmVzdWx0cy5JbnZhbGlkUGFzc3dvcmRdOiBbXG4gICAgICBhc3luYyAob3B0aW9ucz86IHsgcGFnZT86IFBhZ2UgfSkgPT4ge1xuICAgICAgICBjb25zdCBwYWdlID0gb3B0aW9ucz8ucGFnZTtcbiAgICAgICAgaWYgKCFwYWdlKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBoYXNJbnZhbGlkUGFzc3dvcmRFcnJvcihwYWdlKTtcbiAgICAgIH0sXG4gICAgXSxcbiAgICAvLyBbTG9naW5SZXN1bHRzLkFjY291bnRCbG9ja2VkXTogW10sIC8vIFRPRE8gYWRkIHdoZW4gcmVhY2hpbmcgdGhpcyBzY2VuYXJpb1xuICAgIFtMb2dpblJlc3VsdHMuQ2hhbmdlUGFzc3dvcmRdOiBbXG4gICAgICBhc3luYyAob3B0aW9ucz86IHsgcGFnZT86IFBhZ2UgfSkgPT4ge1xuICAgICAgICBjb25zdCBwYWdlID0gb3B0aW9ucz8ucGFnZTtcbiAgICAgICAgaWYgKCFwYWdlKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBoYXNDaGFuZ2VQYXNzd29yZEZvcm0ocGFnZSk7XG4gICAgICB9LFxuICAgIF0sXG4gIH07XG4gIHJldHVybiB1cmxzO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVMb2dpbkZpZWxkcyhjcmVkZW50aWFsczogU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMpIHtcbiAgZGVidWcoJ2NyZWF0ZSBsb2dpbiBmaWVsZHMgZm9yIHVzZXJuYW1lIGFuZCBwYXNzd29yZCcpO1xuICByZXR1cm4gW1xuICAgIHsgc2VsZWN0b3I6ICdbZm9ybWNvbnRyb2xuYW1lPVwidXNlck5hbWVcIl0nLCB2YWx1ZTogY3JlZGVudGlhbHMudXNlcm5hbWUgfSxcbiAgICB7IHNlbGVjdG9yOiAnW2Zvcm1jb250cm9sbmFtZT1cInBhc3N3b3JkXCJdJywgdmFsdWU6IGNyZWRlbnRpYWxzLnBhc3N3b3JkIH0sXG4gIF07XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRQYXJzZWREYXRhVG9UcmFuc2FjdGlvbnMoXG4gIGRhdGE6IENhcmRUcmFuc2FjdGlvbkRldGFpbHNbXSxcbiAgcGVuZGluZ0RhdGE/OiBDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscyB8IG51bGwsXG4gIG9wdGlvbnM/OiBTY3JhcGVyT3B0aW9ucyxcbik6IFRyYW5zYWN0aW9uW10ge1xuICBjb25zdCBwZW5kaW5nVHJhbnNhY3Rpb25zID0gcGVuZGluZ0RhdGE/LnJlc3VsdFxuICAgID8gcGVuZGluZ0RhdGEucmVzdWx0LmNhcmRzTGlzdC5mbGF0TWFwKGNhcmQgPT4gY2FyZC5hdXRoRGV0YWxpc0xpc3QpXG4gICAgOiBbXTtcblxuICBjb25zdCBiYW5rQWNjb3VudHMgPSBkYXRhLmZsYXRNYXAobW9udGhEYXRhID0+IG1vbnRoRGF0YS5yZXN1bHQuYmFua0FjY291bnRzKTtcbiAgY29uc3QgcmVndWxhckRlYml0RGF5cyA9IGJhbmtBY2NvdW50cy5mbGF0TWFwKGFjY291bnRzID0+IGFjY291bnRzLmRlYml0RGF0ZXMpO1xuICBjb25zdCBpbW1lZGlhdGVEZWJpdERheXMgPSBiYW5rQWNjb3VudHMuZmxhdE1hcChhY2NvdW50cyA9PiBhY2NvdW50cy5pbW1pZGlhdGVEZWJpdHMuZGViaXREYXlzKTtcbiAgY29uc3QgY29tcGxldGVkVHJhbnNhY3Rpb25zID0gWy4uLnJlZ3VsYXJEZWJpdERheXMsIC4uLmltbWVkaWF0ZURlYml0RGF5c10uZmxhdE1hcChcbiAgICBkZWJpdERhdGUgPT4gZGViaXREYXRlLnRyYW5zYWN0aW9ucyxcbiAgKTtcblxuICBjb25zdCBhbGw6IChTY3JhcGVkVHJhbnNhY3Rpb24gfCBTY3JhcGVkUGVuZGluZ1RyYW5zYWN0aW9uKVtdID0gWy4uLnBlbmRpbmdUcmFuc2FjdGlvbnMsIC4uLmNvbXBsZXRlZFRyYW5zYWN0aW9uc107XG5cbiAgcmV0dXJuIGFsbC5tYXAodHJhbnNhY3Rpb24gPT4ge1xuICAgIGNvbnN0IG51bU9mUGF5bWVudHMgPSBpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gdHJhbnNhY3Rpb24ubnVtYmVyT2ZQYXltZW50cyA6IHRyYW5zYWN0aW9uLm51bU9mUGF5bWVudHM7XG4gICAgY29uc3QgaW5zdGFsbG1lbnRzID0gbnVtT2ZQYXltZW50c1xuICAgICAgPyB7XG4gICAgICAgICAgbnVtYmVyOiBpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gMSA6IHRyYW5zYWN0aW9uLmN1clBheW1lbnROdW0sXG4gICAgICAgICAgdG90YWw6IG51bU9mUGF5bWVudHMsXG4gICAgICAgIH1cbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgY29uc3QgZGF0ZSA9IG1vbWVudCh0cmFuc2FjdGlvbi50cm5QdXJjaGFzZURhdGUpO1xuXG4gICAgY29uc3QgY2hhcmdlZEFtb3VudCA9IChpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gdHJhbnNhY3Rpb24udHJuQW10IDogdHJhbnNhY3Rpb24uYW10QmVmb3JlQ29udkFuZEluZGV4KSAqIC0xO1xuICAgIGNvbnN0IG9yaWdpbmFsQW1vdW50ID0gdHJhbnNhY3Rpb24udHJuQW10ICogKHRyYW5zYWN0aW9uLnRyblR5cGVDb2RlID09PSBUcm5UeXBlQ29kZS5jcmVkaXQgPyAxIDogLTEpO1xuXG4gICAgY29uc3QgcmVzdWx0OiBUcmFuc2FjdGlvbiA9IHtcbiAgICAgIGlkZW50aWZpZXI6ICFpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gdHJhbnNhY3Rpb24udHJuSW50SWQgOiB1bmRlZmluZWQsXG4gICAgICB0eXBlOiBbVHJuVHlwZUNvZGUucmVndWxhciwgVHJuVHlwZUNvZGUuc3RhbmRpbmdPcmRlcl0uaW5jbHVkZXModHJhbnNhY3Rpb24udHJuVHlwZUNvZGUpXG4gICAgICAgID8gVHJhbnNhY3Rpb25UeXBlcy5Ob3JtYWxcbiAgICAgICAgOiBUcmFuc2FjdGlvblR5cGVzLkluc3RhbGxtZW50cyxcbiAgICAgIHN0YXR1czogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IFRyYW5zYWN0aW9uU3RhdHVzZXMuUGVuZGluZyA6IFRyYW5zYWN0aW9uU3RhdHVzZXMuQ29tcGxldGVkLFxuICAgICAgZGF0ZTogaW5zdGFsbG1lbnRzID8gZGF0ZS5hZGQoaW5zdGFsbG1lbnRzLm51bWJlciAtIDEsICdtb250aCcpLnRvSVNPU3RyaW5nKCkgOiBkYXRlLnRvSVNPU3RyaW5nKCksXG4gICAgICBwcm9jZXNzZWREYXRlOiBpc1BlbmRpbmcodHJhbnNhY3Rpb24pID8gZGF0ZS50b0lTT1N0cmluZygpIDogbmV3IERhdGUodHJhbnNhY3Rpb24uZGViQ3JkRGF0ZSkudG9JU09TdHJpbmcoKSxcbiAgICAgIG9yaWdpbmFsQW1vdW50LFxuICAgICAgb3JpZ2luYWxDdXJyZW5jeTogdHJhbnNhY3Rpb24udHJuQ3VycmVuY3lTeW1ib2wsXG4gICAgICBjaGFyZ2VkQW1vdW50LFxuICAgICAgY2hhcmdlZEN1cnJlbmN5OiAhaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLmRlYkNyZEN1cnJlbmN5U3ltYm9sIDogdW5kZWZpbmVkLFxuICAgICAgZGVzY3JpcHRpb246IHRyYW5zYWN0aW9uLm1lcmNoYW50TmFtZSxcbiAgICAgIG1lbW86IHRyYW5zYWN0aW9uLnRyYW5zVHlwZUNvbW1lbnREZXRhaWxzLnRvU3RyaW5nKCksXG4gICAgICBjYXRlZ29yeTogdHJhbnNhY3Rpb24uYnJhbmNoQ29kZURlc2MsXG4gICAgfTtcblxuICAgIGlmIChpbnN0YWxsbWVudHMpIHtcbiAgICAgIHJlc3VsdC5pbnN0YWxsbWVudHMgPSBpbnN0YWxsbWVudHM7XG4gICAgfVxuXG4gICAgaWYgKG9wdGlvbnM/LmluY2x1ZGVSYXdUcmFuc2FjdGlvbikge1xuICAgICAgcmVzdWx0LnJhd1RyYW5zYWN0aW9uID0gZ2V0UmF3VHJhbnNhY3Rpb24odHJhbnNhY3Rpb24pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH0pO1xufVxuXG50eXBlIFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzID0geyB1c2VybmFtZTogc3RyaW5nOyBwYXNzd29yZDogc3RyaW5nIH07XG5cbmNsYXNzIFZpc2FDYWxTY3JhcGVyIGV4dGVuZHMgQmFzZVNjcmFwZXJXaXRoQnJvd3NlcjxTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscz4ge1xuICBwcml2YXRlIGF1dGhvcml6YXRpb246IHN0cmluZyB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuICBwcml2YXRlIGF1dGhSZXF1ZXN0UHJvbWlzZTogUHJvbWlzZTxIVFRQUmVxdWVzdCB8IHVuZGVmaW5lZD4gfCB1bmRlZmluZWQ7XG5cbiAgb3BlbkxvZ2luUG9wdXAgPSBhc3luYyAoKSA9PiB7XG4gICAgZGVidWcoJ29wZW4gbG9naW4gcG9wdXAsIHdhaXQgdW50aWwgbG9naW4gYnV0dG9uIGF2YWlsYWJsZScpO1xuICAgIGF3YWl0IHdhaXRVbnRpbEVsZW1lbnRGb3VuZCh0aGlzLnBhZ2UsICcjY2NMb2dpbkRlc2t0b3BCdG4nLCB0cnVlKTtcbiAgICBkZWJ1ZygnY2xpY2sgb24gdGhlIGxvZ2luIGJ1dHRvbicpO1xuICAgIGF3YWl0IGNsaWNrQnV0dG9uKHRoaXMucGFnZSwgJyNjY0xvZ2luRGVza3RvcEJ0bicpO1xuICAgIGRlYnVnKCdnZXQgdGhlIGZyYW1lIHRoYXQgaG9sZHMgdGhlIGxvZ2luJyk7XG4gICAgY29uc3QgZnJhbWUgPSBhd2FpdCBnZXRMb2dpbkZyYW1lKHRoaXMucGFnZSk7XG4gICAgZGVidWcoJ3dhaXQgdW50aWwgdGhlIHBhc3N3b3JkIGxvZ2luIHRhYiBoZWFkZXIgaXMgYXZhaWxhYmxlJyk7XG4gICAgYXdhaXQgd2FpdFVudGlsRWxlbWVudEZvdW5kKGZyYW1lLCAnI3JlZ3VsYXItbG9naW4nKTtcbiAgICBkZWJ1ZygnbmF2aWdhdGUgdG8gdGhlIHBhc3N3b3JkIGxvZ2luIHRhYicpO1xuICAgIGF3YWl0IGNsaWNrQnV0dG9uKGZyYW1lLCAnI3JlZ3VsYXItbG9naW4nKTtcbiAgICBkZWJ1Zygnd2FpdCB1bnRpbCB0aGUgcGFzc3dvcmQgbG9naW4gdGFiIGlzIGFjdGl2ZScpO1xuICAgIGF3YWl0IHdhaXRVbnRpbEVsZW1lbnRGb3VuZChmcmFtZSwgJ3JlZ3VsYXItbG9naW4nKTtcblxuICAgIHJldHVybiBmcmFtZTtcbiAgfTtcblxuICBhc3luYyBnZXRDYXJkcygpIHtcbiAgICBjb25zdCBpbml0RGF0YSA9IGF3YWl0IHdhaXRVbnRpbChcbiAgICAgICgpID0+IGdldEZyb21TZXNzaW9uU3RvcmFnZTxJbml0UmVzcG9uc2U+KHRoaXMucGFnZSwgJ2luaXQnKSxcbiAgICAgICdnZXQgaW5pdCBkYXRhIGluIHNlc3Npb24gc3RvcmFnZScsXG4gICAgICAxMDAwMCxcbiAgICAgIDEwMDAsXG4gICAgKTtcbiAgICBpZiAoIWluaXREYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ2NvdWxkIG5vdCBmaW5kIFwiaW5pdFwiIGRhdGEgaW4gc2Vzc2lvbiBzdG9yYWdlJyk7XG4gICAgfVxuICAgIHJldHVybiBpbml0RGF0YT8ucmVzdWx0LmNhcmRzLm1hcCgoeyBjYXJkVW5pcXVlSWQsIGxhc3Q0RGlnaXRzIH0pID0+ICh7IGNhcmRVbmlxdWVJZCwgbGFzdDREaWdpdHMgfSkpO1xuICB9XG5cbiAgYXN5bmMgZ2V0QXV0aG9yaXphdGlvbkhlYWRlcigpIHtcbiAgICBpZiAoIXRoaXMuYXV0aG9yaXphdGlvbikge1xuICAgICAgZGVidWcoJ2ZldGNoaW5nIGF1dGhvcml6YXRpb24gaGVhZGVyJyk7XG4gICAgICBjb25zdCBhdXRoTW9kdWxlID0gYXdhaXQgd2FpdFVudGlsKFxuICAgICAgICBhc3luYyAoKSA9PiBhdXRoTW9kdWxlT3JVbmRlZmluZWQoYXdhaXQgZ2V0RnJvbVNlc3Npb25TdG9yYWdlPEF1dGhNb2R1bGU+KHRoaXMucGFnZSwgJ2F1dGgtbW9kdWxlJykpLFxuICAgICAgICAnZ2V0IGF1dGhvcml6YXRpb24gaGVhZGVyIHdpdGggdmFsaWQgdG9rZW4gaW4gc2Vzc2lvbiBzdG9yYWdlJyxcbiAgICAgICAgMTBfMDAwLFxuICAgICAgICA1MCxcbiAgICAgICk7XG4gICAgICByZXR1cm4gYENBTEF1dGhTY2hlbWUgJHthdXRoTW9kdWxlLmF1dGguY2FsQ29ubmVjdFRva2VufWA7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmF1dGhvcml6YXRpb247XG4gIH1cblxuICBhc3luYyBnZXRYU2l0ZUlkKCkge1xuICAgIC8qXG4gICAgICBJIGRvbid0IGtub3cgaWYgdGhlIGNvbnN0YW50IGJlbG93IHdpbGwgY2hhbmdlIGluIHRoZSBmZWF0dXJlLlxuICAgICAgSWYgc28sIHVzZSB0aGUgbmV4dCBjb2RlOlxuXG4gICAgICByZXR1cm4gdGhpcy5wYWdlLmV2YWx1YXRlKCgpID0+IG5ldyBVdCgpLnhTaXRlSWQpO1xuXG4gICAgICBUbyBnZXQgdGhlIGNsYXNzbmFtZSBzZWFyY2ggZm9yICd4U2l0ZUlkJyBpbiB0aGUgcGFnZSBzb3VyY2VcbiAgICAgIGNsYXNzIFV0IHtcbiAgICAgICAgY29uc3RydWN0b3IoX2UsIG9uLCB5bikge1xuICAgICAgICAgICAgdGhpcy5zdG9yZSA9IF9lLFxuICAgICAgICAgICAgdGhpcy5jb25maWcgPSBvbixcbiAgICAgICAgICAgIHRoaXMuZXZlbnRCdXNTZXJ2aWNlID0geW4sXG4gICAgICAgICAgICB0aGlzLnhTaXRlSWQgPSBcIjA5MDMxOTg3LTI3M0UtMjMxMS05MDZDLThBRjg1QjE3QzhEOVwiLFxuICAgICovXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgnMDkwMzE5ODctMjczRS0yMzExLTkwNkMtOEFGODVCMTdDOEQ5Jyk7XG4gIH1cblxuICBnZXRMb2dpbk9wdGlvbnMoY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKTogTG9naW5PcHRpb25zIHtcbiAgICB0aGlzLmF1dGhSZXF1ZXN0UHJvbWlzZSA9IHRoaXMucGFnZVxuICAgICAgLndhaXRGb3JSZXF1ZXN0KFNTT19BVVRIT1JJWkFUSU9OX1JFUVVFU1RfRU5EUE9JTlQsIHsgdGltZW91dDogMTBfMDAwIH0pXG4gICAgICAuY2F0Y2goZSA9PiB7XG4gICAgICAgIGRlYnVnKCdlcnJvciB3aGlsZSB3YWl0aW5nIGZvciB0aGUgdG9rZW4gcmVxdWVzdCcsIGUpO1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxvZ2luVXJsOiBgJHtMT0dJTl9VUkx9YCxcbiAgICAgIGZpZWxkczogY3JlYXRlTG9naW5GaWVsZHMoY3JlZGVudGlhbHMpLFxuICAgICAgc3VibWl0QnV0dG9uU2VsZWN0b3I6ICdidXR0b25bdHlwZT1cInN1Ym1pdFwiXScsXG4gICAgICBwb3NzaWJsZVJlc3VsdHM6IGdldFBvc3NpYmxlTG9naW5SZXN1bHRzKCksXG4gICAgICBjaGVja1JlYWRpbmVzczogYXN5bmMgKCkgPT4gd2FpdFVudGlsRWxlbWVudEZvdW5kKHRoaXMucGFnZSwgJyNjY0xvZ2luRGVza3RvcEJ0bicpLFxuICAgICAgcHJlQWN0aW9uOiB0aGlzLm9wZW5Mb2dpblBvcHVwLFxuICAgICAgcG9zdEFjdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IHdhaXRGb3JOYXZpZ2F0aW9uKHRoaXMucGFnZSk7XG4gICAgICAgICAgY29uc3QgY3VycmVudFVybCA9IGF3YWl0IGdldEN1cnJlbnRVcmwodGhpcy5wYWdlKTtcbiAgICAgICAgICBpZiAoY3VycmVudFVybC5lbmRzV2l0aCgnc2l0ZS10dXRvcmlhbCcpKSB7XG4gICAgICAgICAgICBhd2FpdCBjbGlja0J1dHRvbih0aGlzLnBhZ2UsICdidXR0b24uYnRuLWNsb3NlJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHJlcXVlc3QgPSBhd2FpdCB0aGlzLmF1dGhSZXF1ZXN0UHJvbWlzZTtcbiAgICAgICAgICB0aGlzLmF1dGhvcml6YXRpb24gPSBTdHJpbmcocmVxdWVzdD8uaGVhZGVycygpLmF1dGhvcml6YXRpb24gfHwgJycpLnRyaW0oKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRVcmwgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSk7XG4gICAgICAgICAgaWYgKGN1cnJlbnRVcmwuZW5kc1dpdGgoJ2Rhc2hib2FyZCcpKSByZXR1cm47XG4gICAgICAgICAgY29uc3QgcmVxdWlyZXNDaGFuZ2VQYXNzd29yZCA9IGF3YWl0IGhhc0NoYW5nZVBhc3N3b3JkRm9ybSh0aGlzLnBhZ2UpO1xuICAgICAgICAgIGlmIChyZXF1aXJlc0NoYW5nZVBhc3N3b3JkKSByZXR1cm47XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIHVzZXJBZ2VudDogYXBpSGVhZGVyc1snVXNlci1BZ2VudCddLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBmZXRjaERhdGEoKTogUHJvbWlzZTxTY3JhcGVyU2NyYXBpbmdSZXN1bHQ+IHtcbiAgICBjb25zdCBkZWZhdWx0U3RhcnRNb21lbnQgPSBtb21lbnQoKS5zdWJ0cmFjdCgxLCAneWVhcnMnKS5zdWJ0cmFjdCg2LCAnbW9udGhzJykuYWRkKDEsICdkYXknKTtcbiAgICBjb25zdCBzdGFydERhdGUgPSB0aGlzLm9wdGlvbnMuc3RhcnREYXRlIHx8IGRlZmF1bHRTdGFydE1vbWVudC50b0RhdGUoKTtcbiAgICBjb25zdCBzdGFydE1vbWVudCA9IG1vbWVudC5tYXgoZGVmYXVsdFN0YXJ0TW9tZW50LCBtb21lbnQoc3RhcnREYXRlKSk7XG4gICAgZGVidWcoYGZldGNoIHRyYW5zYWN0aW9ucyBzdGFydGluZyAke3N0YXJ0TW9tZW50LmZvcm1hdCgpfWApO1xuXG4gICAgY29uc3QgW2NhcmRzLCB4U2l0ZUlkLCBBdXRob3JpemF0aW9uXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIHRoaXMuZ2V0Q2FyZHMoKSxcbiAgICAgIHRoaXMuZ2V0WFNpdGVJZCgpLFxuICAgICAgdGhpcy5nZXRBdXRob3JpemF0aW9uSGVhZGVyKCksXG4gICAgXSk7XG5cbiAgICBjb25zdCBmdXR1cmVNb250aHNUb1NjcmFwZSA9IHRoaXMub3B0aW9ucy5mdXR1cmVNb250aHNUb1NjcmFwZSA/PyAxO1xuXG4gICAgZGVidWcoJ2ZldGNoIGZyYW1lcyAobWlzZ2Fyb3QpIG9mIGNhcmRzJyk7XG4gICAgY29uc3QgZnJhbWVzID0gYXdhaXQgZmV0Y2hQb3N0PEZyYW1lc1Jlc3BvbnNlPihcbiAgICAgIEZSQU1FU19SRVFVRVNUX0VORFBPSU5ULFxuICAgICAgeyBjYXJkc0ZvckZyYW1lRGF0YTogY2FyZHMubWFwKCh7IGNhcmRVbmlxdWVJZCB9KSA9PiAoeyBjYXJkVW5pcXVlSWQgfSkpIH0sXG4gICAgICB7XG4gICAgICAgIEF1dGhvcml6YXRpb24sXG4gICAgICAgICdYLVNpdGUtSWQnOiB4U2l0ZUlkLFxuICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAuLi5hcGlIZWFkZXJzLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgY29uc3QgYWNjb3VudHMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgIGNhcmRzLm1hcChhc3luYyBjYXJkID0+IHtcbiAgICAgICAgY29uc3QgZmluYWxNb250aFRvRmV0Y2hNb21lbnQgPSBtb21lbnQoKS5hZGQoZnV0dXJlTW9udGhzVG9TY3JhcGUsICdtb250aCcpO1xuICAgICAgICBjb25zdCBtb250aHMgPSBmaW5hbE1vbnRoVG9GZXRjaE1vbWVudC5kaWZmKHN0YXJ0TW9tZW50LCAnbW9udGhzJyk7XG4gICAgICAgIGNvbnN0IGFsbE1vbnRoc0RhdGE6IENhcmRUcmFuc2FjdGlvbkRldGFpbHNbXSA9IFtdO1xuICAgICAgICBjb25zdCBmcmFtZSA9IF8uZmluZChmcmFtZXMucmVzdWx0Py5iYW5rSXNzdWVkQ2FyZHM/LmNhcmRMZXZlbEZyYW1lcywgeyBjYXJkVW5pcXVlSWQ6IGNhcmQuY2FyZFVuaXF1ZUlkIH0pO1xuXG4gICAgICAgIGRlYnVnKGBmZXRjaCBwZW5kaW5nIHRyYW5zYWN0aW9ucyBmb3IgY2FyZCAke2NhcmQuY2FyZFVuaXF1ZUlkfWApO1xuICAgICAgICBsZXQgcGVuZGluZ0RhdGEgPSBhd2FpdCBmZXRjaFBvc3QoXG4gICAgICAgICAgUEVORElOR19UUkFOU0FDVElPTlNfUkVRVUVTVF9FTkRQT0lOVCxcbiAgICAgICAgICB7IGNhcmRVbmlxdWVJREFycmF5OiBbY2FyZC5jYXJkVW5pcXVlSWRdIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgQXV0aG9yaXphdGlvbixcbiAgICAgICAgICAgICdYLVNpdGUtSWQnOiB4U2l0ZUlkLFxuICAgICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgIC4uLmFwaUhlYWRlcnMsXG4gICAgICAgICAgfSxcbiAgICAgICAgKTtcblxuICAgICAgICBkZWJ1ZyhgZmV0Y2ggY29tcGxldGVkIHRyYW5zYWN0aW9ucyBmb3IgY2FyZCAke2NhcmQuY2FyZFVuaXF1ZUlkfWApO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8PSBtb250aHM7IGkrKykge1xuICAgICAgICAgIGNvbnN0IG1vbnRoID0gZmluYWxNb250aFRvRmV0Y2hNb21lbnQuY2xvbmUoKS5zdWJ0cmFjdChpLCAnbW9udGhzJyk7XG4gICAgICAgICAgY29uc3QgbW9udGhEYXRhID0gYXdhaXQgZmV0Y2hQb3N0KFxuICAgICAgICAgICAgVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQsXG4gICAgICAgICAgICB7IGNhcmRVbmlxdWVJZDogY2FyZC5jYXJkVW5pcXVlSWQsIG1vbnRoOiBtb250aC5mb3JtYXQoJ00nKSwgeWVhcjogbW9udGguZm9ybWF0KCdZWVlZJykgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgQXV0aG9yaXphdGlvbixcbiAgICAgICAgICAgICAgJ1gtU2l0ZS1JZCc6IHhTaXRlSWQsXG4gICAgICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgICAgIC4uLmFwaUhlYWRlcnMsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICk7XG5cbiAgICAgICAgICBpZiAobW9udGhEYXRhPy5zdGF0dXNDb2RlICE9PSAxKVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgZmFpbGVkIHRvIGZldGNoIHRyYW5zYWN0aW9ucyBmb3IgY2FyZCAke2NhcmQubGFzdDREaWdpdHN9LiBNZXNzYWdlOiAke21vbnRoRGF0YT8udGl0bGUgfHwgJyd9YCxcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICBpZiAoIWlzQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyhtb250aERhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ21vbnRoRGF0YSBpcyBub3Qgb2YgdHlwZSBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzJyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgYWxsTW9udGhzRGF0YS5wdXNoKG1vbnRoRGF0YSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocGVuZGluZ0RhdGE/LnN0YXR1c0NvZGUgIT09IDEgJiYgcGVuZGluZ0RhdGE/LnN0YXR1c0NvZGUgIT09IDk2KSB7XG4gICAgICAgICAgZGVidWcoXG4gICAgICAgICAgICBgZmFpbGVkIHRvIGZldGNoIHBlbmRpbmcgdHJhbnNhY3Rpb25zIGZvciBjYXJkICR7Y2FyZC5sYXN0NERpZ2l0c30uIE1lc3NhZ2U6ICR7cGVuZGluZ0RhdGE/LnRpdGxlIHx8ICcnfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBwZW5kaW5nRGF0YSA9IG51bGw7XG4gICAgICAgIH0gZWxzZSBpZiAoIWlzQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMocGVuZGluZ0RhdGEpKSB7XG4gICAgICAgICAgZGVidWcoJ3BlbmRpbmdEYXRhIGlzIG5vdCBvZiB0eXBlIENhcmRUcmFuc2FjdGlvbkRldGFpbHMnKTtcbiAgICAgICAgICBwZW5kaW5nRGF0YSA9IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0cmFuc2FjdGlvbnMgPSBjb252ZXJ0UGFyc2VkRGF0YVRvVHJhbnNhY3Rpb25zKGFsbE1vbnRoc0RhdGEsIHBlbmRpbmdEYXRhLCB0aGlzLm9wdGlvbnMpO1xuXG4gICAgICAgIGRlYnVnKCdmaWx0ZXIgb3V0IG9sZCB0cmFuc2FjdGlvbnMnKTtcbiAgICAgICAgY29uc3QgdHhucyA9XG4gICAgICAgICAgKHRoaXMub3B0aW9ucy5vdXRwdXREYXRhPy5lbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUgPz8gdHJ1ZSlcbiAgICAgICAgICAgID8gZmlsdGVyT2xkVHJhbnNhY3Rpb25zKHRyYW5zYWN0aW9ucywgbW9tZW50KHN0YXJ0RGF0ZSksIHRoaXMub3B0aW9ucy5jb21iaW5lSW5zdGFsbG1lbnRzIHx8IGZhbHNlKVxuICAgICAgICAgICAgOiB0cmFuc2FjdGlvbnM7XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB0eG5zLFxuICAgICAgICAgIGJhbGFuY2U6IGZyYW1lPy5uZXh0VG90YWxEZWJpdCAhPSBudWxsID8gLWZyYW1lLm5leHRUb3RhbERlYml0IDogdW5kZWZpbmVkLFxuICAgICAgICAgIGFjY291bnROdW1iZXI6IGNhcmQubGFzdDREaWdpdHMsXG4gICAgICAgIH0gYXMgVHJhbnNhY3Rpb25zQWNjb3VudDtcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBkZWJ1ZygncmV0dXJuIHRoZSBzY3JhcGVkIGFjY291bnRzJyk7XG5cbiAgICBkZWJ1ZyhKU09OLnN0cmluZ2lmeShhY2NvdW50cywgbnVsbCwgMikpO1xuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgYWNjb3VudHMsXG4gICAgfTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBWaXNhQ2FsU2NyYXBlcjtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsSUFBQUEsT0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBRUEsSUFBQUMsTUFBQSxHQUFBRCxPQUFBO0FBQ0EsSUFBQUUscUJBQUEsR0FBQUYsT0FBQTtBQUNBLElBQUFHLE1BQUEsR0FBQUgsT0FBQTtBQUNBLElBQUFJLFdBQUEsR0FBQUosT0FBQTtBQUNBLElBQUFLLFFBQUEsR0FBQUwsT0FBQTtBQUNBLElBQUFNLGFBQUEsR0FBQU4sT0FBQTtBQUNBLElBQUFPLFFBQUEsR0FBQVAsT0FBQTtBQUNBLElBQUFRLGNBQUEsR0FBQVIsT0FBQTtBQUNBLElBQUFTLHVCQUFBLEdBQUFULE9BQUE7QUFFQSxJQUFBVSxPQUFBLEdBQUFYLHNCQUFBLENBQUFDLE9BQUE7QUFBdUIsU0FBQUQsdUJBQUFZLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxLQUFBRSxPQUFBLEVBQUFGLENBQUE7QUFFdkIsTUFBTUcsVUFBVSxHQUFHO0VBQ2pCLFlBQVksRUFDVix1SEFBdUg7RUFDekhDLE1BQU0sRUFBRSxzQ0FBc0M7RUFDOUNDLE9BQU8sRUFBRSxzQ0FBc0M7RUFDL0MsaUJBQWlCLEVBQUUscUNBQXFDO0VBQ3hELGdCQUFnQixFQUFFLFdBQVc7RUFDN0IsZ0JBQWdCLEVBQUUsTUFBTTtFQUN4QixnQkFBZ0IsRUFBRTtBQUNwQixDQUFDO0FBQ0QsTUFBTUMsU0FBUyxHQUFH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