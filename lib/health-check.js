import { spawn } from 'child_process';
import { log } from './logger.js';

export class HealthCheck {
  constructor() {
    this.logger = log;
  }

  async waitForUrl({url, maxAttempts = 20, interval = 2000, silent=false}) {
    !silent && this.logger.info(`Waiting for ${url} to be available...`);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await new Promise((resolve) => {
          const curl = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url]);
          let output = '';
          curl.stdout.on('data', (data) => {
            output += data.toString();
          });
          curl.on('close', (code) => {
            resolve({ code, output });
          });
        });

        if (result.code === 0 && result.output === '200') {
          !silent && this.logger.success(`${url} is available`);
          return true;
        }
      } catch (error) {
        !silent && this.logger.verbose(`Attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
    
    !silent && this.logger.error(`Failed to connect to ${url} after ${maxAttempts} attempts`);
    
    return false;
  }
}

// For backward compatibility
export const healthCheck = new HealthCheck(); 