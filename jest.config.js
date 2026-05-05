// Run `npm install` first to get @types/jest
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = {
  testEnvironment:   "node",
  preset:            "ts-jest",
  moduleNameMapper:  { "^@/(.*)$": "<rootDir>/$1" },
  testMatch:         ["**/__tests__/**/*.test.ts"],
  transform:         { "^.+\\.tsx?$": ["ts-jest", { tsconfig: { module: "commonjs" } }] },
};

module.exports = config;
