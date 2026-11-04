declare global {
  namespace NodeJS {
    interface ProcessEnv {
      MODEL_STYLE: "openai" | "anthropic";
      STYLE: "openai" | "anthropic";
      MODEL: string;
      BASE_URL: string;
      MODEL_BASE_URL: string;
      API_KEY: string;
      NODE_ENV: "development" | "production";
    }
  }
}

export {};
