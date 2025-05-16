# Code Review and Verification Guidelines

## Core Principles

1. **Test-First Development**
   - Always write tests before implementing new features or changes
   - Tests should define the expected behavior and requirements
   - Code should be written to make the tests pass
   - No new code should be added without corresponding tests
   - Tests should cover both happy paths and edge cases

2. **Verify, Don't Assume**
   - Never assert code behavior without thorough verification
   - Always trace through the actual code logic before making claims
   - Don't make assumptions about functionality without proper code review

3. **Thorough Code Review**
   - Review the complete relevant code sections
   - Trace through all execution paths
   - Verify variable usage and state changes
   - Check for edge cases and error conditions

4. **Precision in Communication**
   - Be specific and accurate in responses
   - Clearly distinguish between verified facts and assumptions
   - Acknowledge limitations in understanding
   - Admit when you need to review code more thoroughly

5. **Quality Assurance**
   - Double-check your own assertions
   - Verify that suggested changes actually solve the problem
   - Consider potential side effects of changes
   - Test edge cases and error conditions

## Best Practices

1. **Code Review Process**
   - Read the entire relevant code section
   - Trace variable values through the code
   - Verify control flow and logic paths
   - Check for proper error handling
   - Verify state management and side effects

2. **Verification Steps**
   - Review all related files and dependencies
   - Check for proper parameter passing
   - Verify state changes and updates
   - Test edge cases and error conditions
   - Consider performance implications

3. **Communication Guidelines**
   - Be clear about what you've verified
   - Distinguish between facts and assumptions
   - Provide specific code references
   - Explain your reasoning
   - Acknowledge when you need more information

4. **Quality Checks**
   - Verify changes solve the original problem
   - Check for unintended side effects
   - Consider backward compatibility
   - Review error handling
   - Test edge cases 