/** Validation bounds shared between settings schemas and tool forms. */
export declare const LIMITS: {
    readonly ruleName: 100;
    readonly ruleInstruction: 2000;
    readonly evalTimeoutSeconds: {
        readonly min: 30;
        readonly max: 600;
    };
    readonly maxWorkers: {
        readonly min: 1;
        readonly max: 16;
    };
    readonly prepareCommand: 4000;
    readonly promptMaxChars: {
        readonly min: 1000;
        readonly max: 1000000;
    };
    readonly admissionContextMaxPages: {
        readonly min: 1;
        readonly max: 100;
    };
    readonly admissionContextTimeoutMs: {
        readonly min: 1;
        readonly max: 90000;
    };
};
