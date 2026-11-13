export function googleSupport(api=globalThis.chrome){
  return typeof api?.identity?.getRedirectURL==='function'&&typeof api?.identity?.launchWebAuthFlow==='function';
}
