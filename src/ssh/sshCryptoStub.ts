// ssh2 loads this optional native accelerator inside a try/catch. Throwing here
// deliberately selects ssh2's portable JavaScript/Node crypto implementation.
throw new Error('Optional ssh2 native crypto accelerator is disabled.');
