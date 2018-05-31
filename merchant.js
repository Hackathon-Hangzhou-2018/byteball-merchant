/*jslint node: true */
"use strict";
var conf = require('byteballcore/conf.js');
var device = require('byteballcore/device.js');
var walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js');
var crypto = require('crypto');
var fs = require('fs');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var desktopApp = require('byteballcore/desktop_app.js');
require('byteballcore/wallet.js'); // we don't need any of its functions but it listens for hub/* messages

var appDataDir = desktopApp.getAppDataDir();
var KEYS_FILENAME = appDataDir + '/' + conf.KEYS_FILENAME;

var wallet;

var arrToppings = {
	hawaiian: {name: '夏威夷'},
	pepperoni: {name: '意大利辣香肠'},
	mexican: {name: '墨西哥'}
};

var arrYesNoAnswers = {
	yes: '是',
	no: '否'
}

function getToppingsList(){
	var arrItems = [];
	for (var code in arrToppings)
		arrItems.push('['+arrToppings[code].name+'](command:'+code+')');
	return arrItems.join("\t");
}

function getYesNoList(){
	var arrItems = [];
	for (var code in arrYesNoAnswers)
		arrItems.push('['+arrYesNoAnswers[code]+'](command:'+code+')');
	return arrItems.join("\t");
}

function replaceConsoleLog(){
	var clog = console.log;
	console.log = function(){
		Array.prototype.unshift.call(arguments, Date().toString()+':');
		clog.apply(null, arguments);
	}
}

function readKeys(onDone){
	fs.readFile(KEYS_FILENAME, 'utf8', function(err, data){
		if (err){
			console.log('failed to read keys, will gen');
			var devicePrivKey = crypto.randomBytes(32);
			var deviceTempPrivKey = crypto.randomBytes(32);
			var devicePrevTempPrivKey = crypto.randomBytes(32);
			createDir(appDataDir, function(){
				writeKeys(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey, function(){
					onDone(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey);
				});
			});
			return;
		}
		var keys = JSON.parse(data);
		onDone(Buffer(keys.permanent_priv_key, 'base64'), Buffer(keys.temp_priv_key, 'base64'), Buffer(keys.prev_temp_priv_key, 'base64'));
	});
}

function createDir(path, onDone){
	var mode = parseInt('700', 8);
	var parent_dir = require('path'+'').dirname(path);
	fs.mkdir(parent_dir, mode, function(err){
		console.log('mkdir '+parent_dir+': '+err);
		fs.mkdir(path, mode, function(err){
			console.log('mkdir '+path+': '+err);
			onDone();
		});
	});
}

function writeKeys(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey, onDone){
	var keys = {
		permanent_priv_key: devicePrivKey.toString('base64'),
		temp_priv_key: deviceTempPrivKey.toString('base64'),
		prev_temp_priv_key: devicePrevTempPrivKey.toString('base64')
	};
	fs.writeFile(KEYS_FILENAME, JSON.stringify(keys), 'utf8', function(err){
		if (err)
			throw Error("failed to write keys file "+KEYS_FILENAME);
		if (onDone)
			onDone();
	});
}

function readCurrentState(device_address, handleState){
	db.query("SELECT state_id, `order`, step FROM states WHERE device_address=? ORDER BY state_id DESC LIMIT 1", [device_address], function(rows){
		if (rows.length === 0)
			throw Error('no current state');
		var state = rows[0];
		state.order = JSON.parse(state.order);
		handleState(state);
	});
}

function createNewSession(device_address, onDone){
	var step = 'waiting_for_choice_of_pizza';
	db.query("INSERT INTO states (device_address, step, `order`) VALUES (?,?,'{}')", [device_address, step], function(){
		if (onDone)
			onDone();
	});
}

function updateState(state, onDone){
	db.query(
		"UPDATE states SET step=?, `order`=?, amount=?, address=? WHERE state_id=?", 
		[state.step, JSON.stringify(state.order), state.amount, state.address, state.state_id], 
		function(){
			if (onDone)
				onDone();
		}
	);
}

function cancelState(state){
	db.query("UPDATE states SET cancel_date="+db.getNow()+" WHERE state_id=?", [state.state_id]);
}

function createWallet(onDone){
	walletDefinedByKeys.createSinglesigWalletWithExternalPrivateKey(conf.xPubKey, conf.account, conf.homeDeviceAddress, function(_wallet){
		wallet = _wallet;
		onDone();
	});
}

function handleNoWallet(from_address){
	if (from_address === conf.homeDeviceAddress && wallet === null)
		createWallet(function(){
			device.sendMessageToDevice(from_address, 'text', "钱包已创建, 所有新地址将会同步到你的设备");
		});
	else
		device.sendMessageToDevice(from_address, 'text', "店铺还没配置, 请稍后重试");
}



replaceConsoleLog();

if (!conf.permanent_pairing_secret)
	throw Error('no conf.permanent_pairing_secret');
db.query(
	"INSERT "+db.getIgnore()+" INTO pairing_secrets (pairing_secret, expiry_date, is_permanent) VALUES(?, '2035-01-01', 1)", 
	[conf.permanent_pairing_secret]
);

db.query("SELECT wallet FROM wallets", function(rows){
	if (rows.length > 1)
		throw Error('more than 1 wallet');
	if (rows.length === 1)
		wallet = rows[0].wallet;
	else
		wallet = null; // different from undefined
});
	



readKeys(function(devicePrivKey, deviceTempPrivKey, devicePrevTempPrivKey){
	var saveTempKeys = function(new_temp_key, new_prev_temp_key, onDone){
		writeKeys(devicePrivKey, new_temp_key, new_prev_temp_key, onDone);
	};
	device.setDevicePrivateKey(devicePrivKey);
	device.setTempKeys(deviceTempPrivKey, devicePrevTempPrivKey, saveTempKeys);
	device.setDeviceName(conf.deviceName);
	device.setDeviceHub(conf.hub);
	if (conf.bLight){
		var light_wallet = require('byteballcore/light_wallet.js');
		light_wallet.setLightVendorHost(conf.hub);
	}
	var my_device_pubkey = device.getMyDevicePubKey();
	console.log("my device pubkey: "+my_device_pubkey);
	console.log("my pairing code: "+my_device_pubkey+"@"+conf.hub+"#"+conf.permanent_pairing_secret);
});


eventBus.on('paired', function(from_address){
	if (!wallet)
		return handleNoWallet(from_address);
	createNewSession(from_address, function(){
		device.sendMessageToDevice(from_address, 'text', "请选择你的披萨:\n"+getToppingsList()+"\n所有的披萨价格都为 10,000 bytes.");
	});
});

eventBus.on('text', function(from_address, text){
	if (!wallet)
		return handleNoWallet(from_address);
	text = text.trim().toLowerCase();
	readCurrentState(from_address, function(state){
		switch(state.step){
			case 'waiting_for_choice_of_pizza':
				if (!arrToppings[text])
					return device.sendMessageToDevice(from_address, 'text', "请选择一种可用的口味:\n"+getToppingsList());
				state.order.pizza = text;
				state.step = 'waiting_for_choice_of_cola';
				updateState(state);
				device.sendMessageToDevice(from_address, 'text', arrToppings[text].name+" at 10,000 bytes.  加个可乐 (1,000 bytes)?\n"+getYesNoList());
				break;

			case 'waiting_for_choice_of_cola':
				if (!arrYesNoAnswers[text])
					return device.sendMessageToDevice(from_address, 'text', "加个可乐 (1,000 bytes)?  请点击 是 或 否");
				walletDefinedByKeys.issueNextAddress(wallet, 0, function(objAddress){
					state.address = objAddress.address;
					state.order.cola = text;
					state.step = 'waiting_for_payment';
					state.amount = 10000;
					var response = '你的订单: '+arrToppings[state.order.pizza].name;
					if (state.order.cola === 'yes'){
						state.amount += 1000;
						response += ' 和可乐';
					}
					response += ".\n订单总计 "+state.amount+" bytes.  请支付.\n["+state.amount+" bytes](byteball:"+state.address+"?amount="+state.amount+")";
					updateState(state);
					device.sendMessageToDevice(from_address, 'text', response);
				});
				break;

			case 'waiting_for_payment':
				if (text !== 'cancel')
					return device.sendMessageToDevice(from_address, 'text', "等待你支付。 如果你想取消并重新开始, 请点击 [取消](command:cancel).");
				cancelState(state);
				createNewSession(from_address, function(){
					device.sendMessageToDevice(from_address, 'text', "订单取消。\n选择你的披萨:\n"+getToppingsList()+"\n所有的披萨价格都为 10,000 bytes.");
				});
				break;
				
			case 'unconfirmed_payment':
				device.sendMessageToDevice(from_address, 'text', "我们正在确认你的支付。请耐心等待.");
				break;

			case 'done':
			case 'doublespend':
				createNewSession(from_address, function(){
					var response = (state.step === 'done')
						? "订单已经付了，披萨归你了。\n如果你想购买其他的披萨的话，"
						: "你的重复付款已被拒绝了。\n如果你想下一个新订单的话，";
					response += " 选择口味:\n"+getToppingsList()+"\n所有的披萨价格都为 10,000 bytes.";
					device.sendMessageToDevice(from_address, 'text', response);
				});
				break;

			default:
				throw Error("unknown state: "+state);
		}
	});
});


eventBus.on('new_my_transactions', function(arrUnits){
	db.query(
		"SELECT state_id, outputs.unit, device_address, states.amount AS expected_amount, outputs.amount AS paid_amount \n\
		FROM outputs JOIN states USING(address) WHERE outputs.unit IN(?) AND outputs.asset IS NULL AND pay_date IS NULL", 
		[arrUnits], 
		function(rows){
			rows.forEach(function(row){
				if (row.expected_amount !== row.paid_amount)
					return device.sendMessageToDevice(row.device_address, 'text', "收到你的支付: 应收 "+row.expected_amount+" bytes, 收到 "+row.paid_amount+" bytes.  付款将被忽略。");
				db.query("UPDATE states SET pay_date="+db.getNow()+", unit=?, step='unconfirmed_payment' WHERE state_id=?", [row.unit, row.state_id]);
				device.sendMessageToDevice(row.device_address, 'text', "收到你的付款, 请耐心等待被确认。");
			});
		}
	);
});

eventBus.on('my_transactions_became_stable', function(arrUnits){
	db.query(
		"SELECT state_id, device_address, sequence \n\
		FROM states JOIN units USING(unit) WHERE unit IN(?) AND confirmation_date IS NULL", 
		[arrUnits], 
		function(rows){
			rows.forEach(function(row){
				var step = (row.sequence === 'good') ? 'done' : 'doublespend';
				db.query("UPDATE states SET confirmation_date="+db.getNow()+", step=? WHERE state_id=?", [step, row.state_id]);
				device.sendMessageToDevice(
					row.device_address, 'text', 
					(step === 'done') 
						? "确认付款。你点的菜马上就到!" 
						: "你正在重复支付。被拒绝"
				);
				// todo: actually deliver the pizza
			});
		}
	);
});


