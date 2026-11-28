// Shared input error, retained under the legacy name for builder compatibility.
export class SiteInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SiteInputError';
    this.code = code;
  }
}
export { SiteInputError as CollectionError };
