import { log } from './logger.js';

export class HealthCheck {
  constructor() {
    this.logger = log;
  }

  /**
   * Static method to make a simple HTTP/HTTPS request
   * @param {string} url - The URL to check
   * @param {number} timeout - Request timeout in milliseconds (default: 5000)
   * @returns {Promise<{statusCode: number|null, success: boolean, error?: string}>}
   */
  static async makeHttpRequest(url, timeout = 5000) {
    try {
      // Use Node.js http/https module instead of curl for cross-platform compatibility
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? await import('https') : await import('http');
      
      return await new Promise((resolve) => {
        const req = httpModule.default.get(url, (res) => {
          resolve({ statusCode: res.statusCode, success: true });
          res.destroy(); // Close the response stream
        });
        
        req.on('error', (error) => {
          resolve({ statusCode: null, success: false, error: error.message });
        });
        
        req.setTimeout(timeout, () => {
          req.destroy();
          resolve({ statusCode: null, success: false, error: 'Timeout' });
        });
      });
    } catch (error) {
      return { statusCode: null, success: false, error: error.message };
    }
  }

  async waitForUrl({url, maxAttempts = 20, interval = 2000, silent=false}) {
    !silent && this.logger.info(`Waiting for ${url} to be available...`);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await HealthCheck.makeHttpRequest(url, 5000);

        if (result.success && result.statusCode === 200) {
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