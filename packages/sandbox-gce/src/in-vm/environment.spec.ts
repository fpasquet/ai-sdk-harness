import { describe, expect, it } from 'vitest';

import { commandEnvironment } from './environment.js';

const settings = {
  user: 'agent',
  home: '/home/agent',
  workingDirectory: '/workspace',
  path: '/bin',
};
const config = {
  proxy: 'http://10.8.0.2:3128',
  baseUrls: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
};

describe('the environment of a command', () => {
  it('routes the base URLs through the proxy, a value of the command included', () => {
    const env = commandEnvironment(settings, config, {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1/',
      OTHER: 'kept',
    });

    expect(env).toMatchObject({
      HOME: '/home/agent',
      USER: 'agent',
      HTTPS_PROXY: 'http://10.8.0.2:3128',
      NO_PROXY: 'localhost,127.0.0.1,10.8.0.2,172.16.0.0/12,192.168.0.0/16',
      ANTHROPIC_BASE_URL: 'http://10.8.0.2:3128/https/api.anthropic.com/v1',
      OTHER: 'kept',
    });
  });

  it('routes git over HTTPS through the proxy, after the git configuration of the command', () => {
    const env = commandEnvironment(settings, config, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic placeholder',
    });

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic placeholder',
      GIT_CONFIG_KEY_1: 'url.http://10.8.0.2:3128/https/.insteadOf',
      GIT_CONFIG_VALUE_1: 'https://',
    });
    expect(commandEnvironment(settings, config)).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.http://10.8.0.2:3128/https/.insteadOf',
    });
  });

  it('has no proxy before the service configured the agent', () => {
    const env = commandEnvironment(settings, undefined, { A: 'b' });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/agent',
      USER: 'agent',
      LOGNAME: 'agent',
      LANG: 'C.UTF-8',
      A: 'b',
    });
  });
});
