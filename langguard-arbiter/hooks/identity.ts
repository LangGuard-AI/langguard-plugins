// The user name in a verdict request (lane 1 parity). The daemon of the trunk (arbiter-core resolveArbiterIdentity) takes the first of four sources: the variable ARBITER_USER_ID, `git config user.email`, the OS user name, the variable USER. The mod reads the same four through $ (state.ts holds the calls) and sends none of them when all four are empty. The server then writes 'unknown' (decision-core.ts).
// The value is a label for the audit trail. It is not a login: the variable, the git config of the repository and USER are all writable by the person at the keyboard and by the model, as they are on the trunk. The API key names the device.

export const userIdOf = (text: string | null | undefined): string | null => {
  const id = (text ?? '').trim()
  return id === '' ? null : id
}

// `whoami` prints DOMAIN\name on Windows. The OS user name of the trunk (os.userInfo) is the name alone.
export const osUserOf = (text: string | null | undefined): string | null => userIdOf((text ?? '').trim().split('\\').pop())
