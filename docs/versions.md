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


### 2.4.2
* Fix some Promise.all instances to be Promise.allSettled
* Fix order of code which could be causing the process to hang
