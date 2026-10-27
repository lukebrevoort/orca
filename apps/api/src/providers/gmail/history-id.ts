export function isValidGmailHistoryId(value: string): boolean {
  return /^[0-9]{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
