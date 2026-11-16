// These historical protocol bytes are required to read documents created before
// the MyDocuments rename. They are not product names and must not be rewritten.
const previousEncryptionNamespace = 'vault';
export function legacyEncryptionContext(context: string): string | null {
  return context.startsWith('mydocuments:')
    ? `${previousEncryptionNamespace}:${context.slice('mydocuments:'.length)}`
    : null;
}
