/** Return required configuration without ever including its value in an error. */
export function requireConfig(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}
