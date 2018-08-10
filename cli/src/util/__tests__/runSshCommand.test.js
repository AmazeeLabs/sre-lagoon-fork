// @flow

import execa from 'execa';
// import { getSshConfig } from '../../config/getSshConfig';
import { runSshCommand } from '../runSshCommand';

jest.mock('execa');

jest.mock('../../config/getSshConfig', () => ({
  getSshConfig: () => ({ username: 'lagoon', host: 'localhost', port: 2020 }),
}));

// Flow does not know which objects are actual mocks
// this function casts given parameter to JestMockFn
const _castMockForFlow = (mockFn: any): JestMockFn<any, any> => mockFn;

const mockedExeca = _castMockForFlow(execa);
const stdout = 'mocked stdout content\nsecondline';

mockedExeca.mockImplementation(async () => ({
  stdout,
}));

describe('runSshCommand', () => {
  it('should call execa with correct arguments and return stdout', async () => {
    const returned = await runSshCommand({
      command: 'token',
      identity: './identity/path',
    });
    const execaCalls = mockedExeca.mock.calls;
    expect(execaCalls.length).toBe(1);
    expect(execaCalls).toMatchSnapshot();
    expect(returned).toBe(stdout);
  });

  it('should throw first line of stderr on error', async () => {
    const stdErrFirstLine = 'mocked stderr content';
    mockedExeca.mockImplementationOnce(async () => {
      throw {
        stderr: `${stdErrFirstLine}\nanother second line`,
      };
    });
    try {
      await runSshCommand({
        command: 'token',
        identity: './identity/path',
      });
    } catch (err) {
      expect(err).toBe(stdErrFirstLine);
    }
  });
});
