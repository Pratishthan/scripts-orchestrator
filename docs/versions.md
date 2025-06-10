### 1.0
Works!

### 2.0
* Added 'phases' so that some sequencing can be added if necessary
* Noticed that running `jest` & `storybook` together was causing some corruption. Added process isolation. 

### 2.1
* Added support for kill_command
* Improved method signatures (single parameter)
* Retried commands now append to the original log file rather than truncating them first

### 2.2
* Dependencies are immediatley terminated rather than waiting for the cleanup

### 2.3
* Windows functionality had got broken - I was using unix-specific commands
