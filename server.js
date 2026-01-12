const express = require("express");
const calc = require("./calc");
const app = express();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

// parse application/json
app.use(express.json())

// Shared calculation logic
function performCalculation(data) {
	const gen = calc.Generations.get((typeof data.gen === 'undefined') ? 9 : data.gen);
	let error = "";
	if(typeof data.attackingPokemon === 'undefined')
		error += "attackingPokemon must exist and have a valid pokemon name\n";
	if(typeof data.defendingPokemon === 'undefined')
		error += "defendingPokemon must exist and have a valid pokemon name\n";
	if(error)
		throw new Error(error)

	const result = calc.calculate(
		gen,
		new calc.Pokemon(gen, data.attackingPokemon, data.attackingPokemonOptions),
		new calc.Pokemon(gen, data.defendingPokemon, data.defendingPokemonOptions),
		new calc.Move(gen, data.moveName),
		new calc.Field((typeof data.field === 'undefined') ? undefined : data.field)
	);
	return result;
}

// GET endpoint (legacy, supports query param 'body')
app.get("/calculate", (req, res, next) => {
	try {
		// Support body in query string for GET requests
		let data = req.body;
		if (req.query.body) {
			data = JSON.parse(req.query.body);
		}
		const result = performCalculation(data);
		res.json(result);
	} catch (e) {
		res.status(400).json({ error: e.message });
	}
});

// POST endpoint (new, for chat API)
app.post("/calculate", (req, res, next) => {
	try {
		const result = performCalculation(req.body);
		res.json(result);
	} catch (e) {
		res.status(400).json({ error: e.message });
	}
});

// Health check
app.get("/health", (req, res) => {
	res.json({ status: "ok" });
});

app.use(express.static('dist'))
