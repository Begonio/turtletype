import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectNumberFromClientId, resolvePickerConfig } from './pickerConfig.js';

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';

describe('projectNumberFromClientId', () => {
  it('reads the project number off a Google client ID', () => {
    assert.equal(projectNumberFromClientId(CLIENT_ID), '123456789012');
  });

  it('returns empty rather than a guess when the ID is not shaped that way', () => {
    // A wrong appId is worse than a missing one: the Picker still opens and
    // the file it returns is shared with a different project, so the failure
    // shows up later as a 404 on the chosen document.
    assert.equal(projectNumberFromClientId('not-a-client-id'), '');
    assert.equal(projectNumberFromClientId(''), '');
    assert.equal(projectNumberFromClientId('abc-123.apps.googleusercontent.com'), '');
  });
});

describe('resolvePickerConfig', () => {
  it('is enabled once a browser API key is configured', () => {
    const settings = resolvePickerConfig({ clientId: CLIENT_ID, apiKey: 'AIzaSyTest' });
    assert.equal(settings.enabled, true);
    assert.equal(settings.appId, '123456789012');
    assert.equal(settings.apiKey, 'AIzaSyTest');
  });

  it('prefers an explicit appId over the one in the client ID', () => {
    const settings = resolvePickerConfig({
      clientId: CLIENT_ID,
      apiKey: 'AIzaSyTest',
      appId: '999',
    });
    assert.equal(settings.appId, '999');
  });

  it('stays off when the API key is missing, so the paste field remains the way in', () => {
    assert.equal(resolvePickerConfig({ clientId: CLIENT_ID }).enabled, false);
    assert.equal(resolvePickerConfig({ clientId: CLIENT_ID, apiKey: '   ' }).enabled, false);
  });

  it('stays off when nothing can supply an appId', () => {
    const settings = resolvePickerConfig({ clientId: 'malformed', apiKey: 'AIzaSyTest' });
    assert.equal(settings.enabled, false);
  });
});
