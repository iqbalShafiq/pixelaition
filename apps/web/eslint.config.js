import config from "@pixelaition/config/eslint";

export default [
  ...config,
  {
    rules: {
      "react/react-in-jsx-scope": "off",
    },
  },
];
