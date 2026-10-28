/** Evaluated only when the desktop sync component is loaded. */
export function nativeModule<T>(name: string): T {
  return (window as unknown as { require(name: string): T }).require(name);
}
