/**
 * The countries the chat assistant tells people we Buy (on-ramp) and Sell
 * (off-ramp) in. Hardcoded on purpose: the list rarely changes and the
 * assistant should never depend on a network call to know India is covered.
 *
 * To refresh: node scripts/check-ramp-support.mjs countries — then paste the
 * two lists below. Last copied from ChainRails on 2026-10-28.
 */

export type CountryName = { country: string; currency: string };

function toCountries(rows: [string, string][]): CountryName[] {
  return rows.map(([country, currency]) => ({ country, currency }));
}

// 85 countries
export const BUY_COUNTRIES = toCountries([
  ["Argentina", "ARS"],
  ["Australia", "AUD"],
  ["Austria", "EUR"],
  ["Belgium", "EUR"],
  ["Benin", "XOF"],
  ["Brazil", "BRL"],
  ["Botswana", "BWP"],
  ["Burkina Faso", "XOF"],
  ["Cameroon", "XAF"],
  ["Canada", "CAD"],
  ["Chile", "CLP"],
  ["Colombia", "COP"],
  ["Croatia", "EUR"],
  ["Cyprus", "EUR"],
  ["Czechia", "CZK"],
  ["Denmark", "DKK"],
  ["Dominican Republic", "DOP"],
  ["Ecuador", "USD"],
  ["El Salvador", "USD"],
  ["Estonia", "EUR"],
  ["Finland", "EUR"],
  ["France", "EUR"],
  ["Gabon", "XAF"],
  ["Germany", "EUR"],
  ["Ghana", "GHS"],
  ["Greece", "EUR"],
  ["Hong Kong", "HKD"],
  ["India", "INR"],
  ["Indonesia", "IDR"],
  ["Ireland", "EUR"],
  ["Ivory Coast", "XOF"],
  ["Italy", "EUR"],
  ["Japan", "JPY"],
  ["Kenya", "KES"],
  ["Kiribati", "AUD"],
  ["Latvia", "EUR"],
  ["Liechtenstein", "CHF"],
  ["Lithuania", "EUR"],
  ["Luxembourg", "EUR"],
  ["Malawi", "MWK"],
  ["Malta", "EUR"],
  ["Marshall Islands", "USD"],
  ["Mexico", "MXN"],
  ["Micronesia", "USD"],
  ["Montenegro", "EUR"],
  ["Nauru", "AUD"],
  ["Netherlands", "EUR"],
  ["New Zealand", "NZD"],
  ["Nigeria", "NGN"],
  ["Norway", "NOK"],
  ["Oman", "OMR"],
  ["Peru", "PEN"],
  ["Philippines", "PHP"],
  ["Poland", "PLN"],
  ["Portugal", "EUR"],
  ["Republic of the Congo", "XAF"],
  ["Romania", "RON"],
  ["Rwanda", "RWF"],
  ["San Marino", "EUR"],
  ["Senegal", "XOF"],
  ["Singapore", "SGD"],
  ["Slovakia", "EUR"],
  ["Slovenia", "EUR"],
  ["South Africa", "ZAR"],
  ["Spain", "EUR"],
  ["Sweden", "SEK"],
  ["Switzerland", "CHF"],
  ["Tanzania", "TZS"],
  ["Thailand", "THB"],
  ["Timor-Leste", "USD"],
  ["Togo", "XOF"],
  ["Turkey", "TRY"],
  ["Tuvalu", "AUD"],
  ["Uganda", "UGX"],
  ["Ukraine", "UAH"],
  ["United Arab Emirates", "AED"],
  ["United Kingdom", "GBP"],
  ["United States", "USD"],
  ["Viet Nam", "VND"],
  ["Zambia", "ZMW"],
  ["China", "CNY"],
  ["Hungary", "HUF"],
  ["Israel", "ILS"],
  ["Malaysia", "MYR"],
  ["Saudi Arabia", "SAR"],
]);

// 20 countries
export const SELL_COUNTRIES = toCountries([
  ["Argentina", "ARS"],
  ["Benin", "XOF"],
  ["Brazil", "BRL"],
  ["Botswana", "BWP"],
  ["Cameroon", "XAF"],
  ["Colombia", "COP"],
  ["Gabon", "XAF"],
  ["Ghana", "GHS"],
  ["Ivory Coast", "XOF"],
  ["Kenya", "KES"],
  ["Malawi", "MWK"],
  ["Mexico", "MXN"],
  ["Nigeria", "NGN"],
  ["Republic of the Congo", "XAF"],
  ["Rwanda", "RWF"],
  ["Senegal", "XOF"],
  ["Tanzania", "TZS"],
  ["Togo", "XOF"],
  ["Uganda", "UGX"],
  ["Zambia", "ZMW"],
]);

/** "India (INR), Malawi (MWK), …" for the prompt. */
export function countryLine(list: CountryName[]): string {
  return list.map((c) => `${c.country} (${c.currency})`).join(", ");
}
