const express = require("express");
const cors = require("cors");

const requestLogger = require("./middleware/requestLogger");
const customerRoutes = require("./routes/customerRoutes");

const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use(customerRoutes);

module.exports = app;
