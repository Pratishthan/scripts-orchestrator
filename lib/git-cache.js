import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

export class GitCache {
  constructor(logFolder = 'scripts-orchestrator-logs') {
    this.logFolder = logFolder;
    this.cacheFileName = '.git-hash-cache';
  }

  /**
   * Execute a git command and return the output
   * @param {string[]} args - Git command arguments
   * @returns {Promise<{success: boolean, output: string}>}
   */
  async executeGitCommand(args) {
    return new Promise((resolve) => {
      const gitProcess = spawn('git', args, {
        cwd: process.cwd(),
        shell: false,
      });

      let output = '';
      let errorOutput = '';

      gitProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, output: output.trim() });
        } else {
          resolve({ success: false, output: errorOutput.trim() });
        }
      });

      gitProcess.on('error', (error) => {
        resolve({ success: false, output: error.message });
      });
    });
  }

  /**
   * Get the current git commit hash
   * @returns {Promise<string|null>}
   */
  async getCurrentCommitHash() {
    const result = await this.executeGitCommand(['rev-parse', 'HEAD']);
    if (result.success) {
      return result.output;
    }
    log.verbose(`Failed to get git commit hash: ${result.output}`);
    return null;
  }

  /**
   * Check if there are any staged or unstaged changes
   * @returns {Promise<boolean>}
   */
  async hasGitChanges() {
    // Check for staged and unstaged changes
    const statusResult = await this.executeGitCommand(['status', '--porcelain']);
    
    if (!statusResult.success) {
      log.verbose(`Failed to check git status: ${statusResult.output}`);
      // If we can't check git status, assume there are changes to be safe
      return true;
    }

    // If there's any output, there are changes
    return statusResult.output.length > 0;
  }

  /**
   * Get the path to the cache file
   * @returns {string}
   */
  getCacheFilePath() {
    const baseDir = this.logFolder ? path.resolve(this.logFolder) : process.cwd();
    const LOGS_DIR = path.join(baseDir, 'scripts-orchestrator-logs');
    return path.join(LOGS_DIR, this.cacheFileName);
  }

  /**
   * Read the cached git hash
   * @returns {string|null}
   */
  readCachedHash() {
    const cacheFilePath = this.getCacheFilePath();
    
    try {
      if (fs.existsSync(cacheFilePath)) {
        const cachedHash = fs.readFileSync(cacheFilePath, 'utf8').trim();
        log.verbose(`Read cached git hash: ${cachedHash}`);
        return cachedHash;
      }
    } catch (error) {
      log.verbose(`Failed to read cached git hash: ${error.message}`);
    }
    
    return null;
  }

  /**
   * Write the current git hash to cache
   * @param {string} hash
   * @returns {boolean}
   */
  writeCachedHash(hash) {
    const cacheFilePath = this.getCacheFilePath();
    
    try {
      // Ensure the directory exists
      const cacheDir = path.dirname(cacheFilePath);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      
      fs.writeFileSync(cacheFilePath, hash, 'utf8');
      log.verbose(`Wrote git hash to cache: ${hash}`);
      return true;
    } catch (error) {
      log.error(`Failed to write git hash to cache: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if the orchestrator should skip running based on git state
   * @returns {Promise<boolean>} - true if should skip, false if should run
   */
  async shouldSkipExecution() {
    log.verbose('Checking git state for caching...');

    // Get current commit hash
    const currentHash = await this.getCurrentCommitHash();
    if (!currentHash) {
      log.verbose('Could not get current git hash, will not skip execution');
      return false;
    }

    // Get cached hash
    const cachedHash = this.readCachedHash();
    if (!cachedHash) {
      log.verbose('No cached git hash found, will not skip execution');
      return false;
    }

    // Check if hashes match
    if (currentHash !== cachedHash) {
      log.verbose(`Git hash changed (${cachedHash.substring(0, 7)} -> ${currentHash.substring(0, 7)}), will not skip execution`);
      return false;
    }

    // Check for uncommitted changes
    const hasChanges = await this.hasGitChanges();
    if (hasChanges) {
      log.verbose('Git repository has uncommitted changes, will not skip execution');
      return false;
    }

    // All conditions met - can skip
    log.info(`✓ Git state unchanged (${currentHash.substring(0, 7)}), skipping execution`);
    return true;
  }

  /**
   * Update the cached git hash with the current commit
   * @returns {Promise<void>}
   */
  async updateCache() {
    const currentHash = await this.getCurrentCommitHash();
    if (currentHash) {
      this.writeCachedHash(currentHash);
    }
  }
}

// Export a singleton instance
export const gitCache = new GitCache();

