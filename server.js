const express = require("express");
const calc = require("./calc");
const app = express();

const SERVER_VERSION = "2026-07-30-batch-matchup";
const BATCH_MAX_PAIRS = 500;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

// parse application/json (batch matchup payloads can be a few hundred KB)
app.use(express.json({ limit: "2mb" }))

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

// ---- Batch matchup (MyPokemoem 설계문서 §5.3, P0-3) --------------------------
// POST /batch/matchup
// body: { gen: 0, field: {...}, pairs: [{ a: {pokemon, options, moves[<=4]},
//                                          x: {pokemon, options, moves[<=4]} }] }
// 각 쌍: A의 기술<=4 x X, X의 기술<=4 x A 데미지 롤 + 실효 스피드 비교.
// 쌍 단위 오류 격리(불량 이름은 해당 쌍만 {error}) — 배치 전체 실패 금지.
// 스피드 verdict 는 v1 단순화(스카프류 1.5x만 반영, §5.3) — 원값(spe)도 함께 반환.

const SPEED_ITEM_MODS = {
	"Choice Scarf": 1.5,
};

function effectiveSpeed(pokemon) {
	const raw = pokemon.stats.spe;
	const mod = SPEED_ITEM_MODS[pokemon.item] || 1;
	return Math.floor(raw * mod);
}

function movesAgainst(gen, attacker, defender, moves, field) {
	const out = [];
	for (const moveName of (moves || []).slice(0, 4)) {
		try {
			const result = calc.calculate(
				gen, attacker, defender, new calc.Move(gen, moveName), field
			);
			let damage = result.damage;
			if (!Array.isArray(damage)) damage = [damage];
			out.push({
				move: moveName,
				damage: damage,
				defender_hp: result.defender.stats.hp,
			});
		} catch (e) {
			out.push({ move: moveName, error: e.message });
		}
	}
	return out;
}

app.post("/batch/matchup", (req, res) => {
	try {
		const body = req.body || {};
		const pairs = body.pairs;
		if (!Array.isArray(pairs) || pairs.length === 0) {
			return res.status(400).json({ error: "pairs must be a non-empty array" });
		}
		if (pairs.length > BATCH_MAX_PAIRS) {
			return res.status(400).json({
				error: `pairs length ${pairs.length} exceeds max ${BATCH_MAX_PAIRS} — chunk the request`,
			});
		}
		const gen = calc.Generations.get((typeof body.gen === 'undefined') ? 0 : body.gen);
		const results = pairs.map((pair) => {
			try {
				const field = new calc.Field((typeof body.field === 'undefined') ? undefined : body.field);
				const a = new calc.Pokemon(gen, pair.a.pokemon, pair.a.options || {});
				const x = new calc.Pokemon(gen, pair.x.pokemon, pair.x.options || {});
				const aSpe = effectiveSpeed(a);
				const xSpe = effectiveSpeed(x);
				return {
					a_to_x: { moves: movesAgainst(gen, a, x, pair.a.moves, field), defender_hp: x.stats.hp },
					x_to_a: { moves: movesAgainst(gen, x, a, pair.x.moves, field), defender_hp: a.stats.hp },
					a_spe: aSpe,
					x_spe: xSpe,
					speed: aSpe > xSpe ? "a_first" : (xSpe > aSpe ? "x_first" : "tie"),
				};
			} catch (e) {
				return { error: e.message };
			}
		});
		res.json({ gen: gen.num, count: results.length, results: results });
	} catch (e) {
		res.status(400).json({ error: e.message });
	}
});

// Health check
app.get("/health", (req, res) => {
	res.json({ status: "ok", version: SERVER_VERSION });
});

app.use(express.static('dist'))
