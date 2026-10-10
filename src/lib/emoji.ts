/** `:shortcode:` → emoji. A curated, GitHub-compatible subset; unknown codes stay literal text. */
const GROUPS: Record<string, string> = {
	'smile 😄|grinning 😀|laughing 😆|joy 😂|wink 😉|blush 😊|heart_eyes 😍|sunglasses 😎|thinking 🤔|neutral_face 😐|sob 😭|cry 😢|rage 😡|scream 😱|sweat_smile 😅|innocent 😇|upside_down_face 🙃|slightly_smiling_face 🙂|relieved 😌|sleeping 😴|nerd_face 🤓|partying_face 🥳|hugs 🤗|yum 😋|zany_face 🤪|exploding_head 🤯|face_palm 🤦|shrug 🤷|skull 💀|ghost 👻|robot 🤖|poop 💩|see_no_evil 🙈': '',
	'+1 👍|thumbsup 👍|-1 👎|thumbsdown 👎|clap 👏|wave 👋|raised_hands 🙌|pray 🙏|ok_hand 👌|v ✌️|muscle 💪|point_right 👉|point_left 👈|point_up ☝️|point_down 👇|eyes 👀|brain 🧠|handshake 🤝|writing_hand ✍️|fist ✊|crossed_fingers 🤞': '',
	'heart ❤️|orange_heart 🧡|yellow_heart 💛|green_heart 💚|blue_heart 💙|purple_heart 💜|black_heart 🖤|broken_heart 💔|sparkling_heart 💖|100 💯|fire 🔥|star ⭐|star2 🌟|sparkles ✨|zap ⚡|boom 💥|tada 🎉|confetti_ball 🎊|balloon 🎈|gift 🎁|trophy 🏆|medal_sports 🏅|crown 👑|gem 💎|rocket 🚀|bulb 💡|bell 🔔|mega 📣|speech_balloon 💬|thought_balloon 💭|zzz 💤': '',
	'white_check_mark ✅|heavy_check_mark ✔️|ballot_box_with_check ☑️|x ❌|negative_squared_cross_mark ❎|warning ⚠️|no_entry ⛔|no_entry_sign 🚫|stop_sign 🛑|question ❓|grey_question ❔|exclamation ❗|grey_exclamation ❕|bangbang ‼️|information_source ℹ️|heavy_plus_sign ➕|heavy_minus_sign ➖|arrow_right ➡️|arrow_left ⬅️|arrow_up ⬆️|arrow_down ⬇️|arrows_counterclockwise 🔄|repeat 🔁|new 🆕|free 🆓|ok 🆗|sos 🆘|red_circle 🔴|large_orange_circle 🟠|large_yellow_circle 🟡|green_circle 🟢|large_blue_circle 🔵|purple_circle 🟣|white_circle ⚪|black_circle ⚫': '',
	'memo 📝|pencil 📝|pencil2 ✏️|book 📖|books 📚|bookmark 🔖|bookmark_tabs 📑|clipboard 📋|page_facing_up 📄|file_folder 📁|open_file_folder 📂|card_index 📇|calendar 📆|date 📅|chart_with_upwards_trend 📈|chart_with_downwards_trend 📉|bar_chart 📊|pushpin 📌|round_pushpin 📍|paperclip 📎|link 🔗|lock 🔒|unlock 🔓|key 🔑|mag 🔍|mag_right 🔎|label 🏷️|inbox_tray 📥|outbox_tray 📤|package 📦|email 📧|envelope ✉️|newspaper 📰|scroll 📜|hourglass ⌛|alarm_clock ⏰|stopwatch ⏱️|watch ⌚': '',
	'computer 💻|desktop_computer 🖥️|keyboard ⌨️|iphone 📱|phone ☎️|battery 🔋|electric_plug 🔌|floppy_disk 💾|cd 💿|camera 📷|movie_camera 🎥|microphone 🎤|headphones 🎧|tv 📺|satellite 📡|wrench 🔧|hammer 🔨|hammer_and_wrench 🛠️|gear ⚙️|nut_and_bolt 🔩|toolbox 🧰|bug 🐛|microscope 🔬|telescope 🔭|test_tube 🧪|dna 🧬|pill 💊|syringe 💉|shield 🛡️|crossed_swords ⚔️|dart 🎯|game_die 🎲|jigsaw 🧩|art 🎨|musical_note 🎵|guitar 🎸': '',
	'sun_with_face 🌞|sunny ☀️|cloud ☁️|partly_sunny ⛅|umbrella ☔|snowflake ❄️|rainbow 🌈|ocean 🌊|earth_africa 🌍|earth_americas 🌎|globe_with_meridians 🌐|volcano 🌋|mountain ⛰️|seedling 🌱|evergreen_tree 🌲|deciduous_tree 🌳|palm_tree 🌴|cactus 🌵|herb 🌿|four_leaf_clover 🍀|maple_leaf 🍁|cherry_blossom 🌸|rose 🌹|sunflower 🌻|moon 🌙|full_moon 🌕|comet ☄️|milky_way 🌌': '',
	'dog 🐶|cat 🐱|mouse 🐭|rabbit 🐰|fox_face 🦊|bear 🐻|panda_face 🐼|koala 🐨|tiger 🐯|lion 🦁|cow 🐮|pig 🐷|frog 🐸|monkey 🐵|chicken 🐔|penguin 🐧|bird 🐦|eagle 🦅|owl 🦉|bee 🐝|butterfly 🦋|snail 🐌|turtle 🐢|snake 🐍|octopus 🐙|whale 🐳|dolphin 🐬|fish 🐟|unicorn 🦄|dragon 🐉|t-rex 🦖|elephant 🐘': '',
	'coffee ☕|tea 🍵|beer 🍺|beers 🍻|wine_glass 🍷|cocktail 🍸|pizza 🍕|hamburger 🍔|fries 🍟|taco 🌮|sushi 🍣|ramen 🍜|spaghetti 🍝|bread 🍞|cheese 🧀|egg 🥚|apple 🍎|green_apple 🍏|banana 🍌|lemon 🍋|strawberry 🍓|cherries 🍒|grapes 🍇|watermelon 🍉|avocado 🥑|carrot 🥕|corn 🌽|cake 🍰|birthday 🎂|cookie 🍪|chocolate_bar 🍫|doughnut 🍩|ice_cream 🍨|popcorn 🍿': '',
	'house 🏠|office 🏢|school 🏫|hospital 🏥|bank 🏦|factory 🏭|church ⛪|tent ⛺|car 🚗|taxi 🚕|bus 🚌|train 🚆|bike 🚲|airplane ✈️|ship 🚢|anchor ⚓|fuelpump ⛽|traffic_light 🚦|construction 🚧|checkered_flag 🏁|triangular_flag_on_post 🚩|white_flag 🏳️|soccer ⚽|basketball 🏀|football 🏈|tennis 🎾|golf ⛳|running 🏃|walking 🚶|swimmer 🏊|moneybag 💰|dollar 💵|euro 💶|credit_card 💳|chart 💹|shopping_cart 🛒|hourglass_flowing_sand ⏳|recycle ♻️|infinity ♾️|peace_symbol ☮️|eight_pointed_black_star ✴️|copyright ©️|registered ®️|tm ™️'
	: ''
};

export const EMOJI: ReadonlyMap<string, string> = new Map(
	Object.keys(GROUPS)
		.flatMap((g) => g.split('|'))
		.map((e) => {
			const i = e.indexOf(' ');
			return [e.slice(0, i), e.slice(i + 1)] as const;
		})
);
