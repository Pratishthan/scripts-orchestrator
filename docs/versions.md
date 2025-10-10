### 1.0.0
Works!

### 2.0.0
* Added 'phases' so that some sequencing can be added if necessary
* Noticed that running `jest` & `storybook` together was causing some corruption. Added process isolation. 

### 2.1.0
* Added support for kill_command
* Improved method signatures (single parameter)
* Retried commands now append to the original log file rather than truncating them first

### 2.2.0
* Dependencies are immediatley terminated rather than waiting for the cleanup

### 2.3.0
* Windows functionality had got broken - I was using unix-specific commands

### 2.4.0
* Fix logic to fail catastrophically if sub-commands fail. 


#### 2.4.2
* Fix some Promise.all instances to be Promise.allSettled
* Fix order of code which could be causing the process to hang

### 2.5.0
* Added support for starting from a specific phase
* New command line argument `--phase <phase-name>` to specify starting phase
* New configuration option `start_phase` to set default starting phase
* Command line arguments take precedence over configuration file settings
* Improved error handling with validation of specified start phase
* Commands in skipped phases are properly marked in the final summary

### 2.6.0
* Added support for configurable log folder location
* New command line argument `--logFolder <directory>` to specify parent directory for logs
* New configuration option `log_folder` to set default log folder parent directory
* The `scripts-orchestrator-logs` folder will be created inside the specified directory
* Cross-platform compatibility for Windows, macOS, and Linux
* Automatic directory creation with recursive path support
* Command line arguments take precedence over configuration file settings

#### 2.7.0
* Improved handling of log file name.
* Added support for optional phases