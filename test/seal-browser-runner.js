/* jshint node: true */
/*
 * Headless-Chrome driver for the jQuery QUnit suite (test/index.html).
 *
 * Usage:
 *   NODE_PATH=/path/to/node_modules (with puppeteer-core) \
 *   SEAL_CHROME_BIN=/usr/bin/google-chrome \
 *   node test/seal-browser-runner.js http://127.0.0.1:8000/test/index.html?dev
 *
 * Environment:
 *   SEAL_CHROME_BIN   Chrome/Chromium executable (falls back to PUPPETEER_EXECUTABLE_PATH)
 *   SEAL_SKIP_TESTS   ";;"-separated list of "module: test name" entries to de-register
 *   SEAL_TIMEOUT_MS   overall timeout in milliseconds (default 1800000)
 *
 * Exits non-zero on any failed assertion, any unmatched skip entry, an empty run,
 * a browser launch/navigation error, or a timeout.
 */
(function() {
	"use strict";

	var puppeteer = require( "puppeteer-core" ),
		targetUrl = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html?dev",
		chromeBin = process.env.SEAL_CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH,
		timeoutMs = parseInt( process.env.SEAL_TIMEOUT_MS || "1800000", 10 ),
		skipList = ( process.env.SEAL_SKIP_TESTS || "" ).split( ";;" ),
		emitPrefix = "__SEAL_QUNIT__",
		modules = {},
		moduleOrder = [],
		failures = [],
		skipped = [],
		state = {
			tests: 0,
			testsPassed: 0,
			testsFailed: 0,
			currentTest: null,
			done: null
		},
		browser = null,
		finished = false,
		timer = null,
		i;

	for ( i = skipList.length - 1; i >= 0; i-- ) {
		skipList[ i ] = skipList[ i ].replace( /^\s+|\s+$/g, "" );
		if ( !skipList[ i ] ) {
			skipList.splice( i, 1 );
		}
	}

	if ( !chromeBin ) {
		console.error( "SEAL_CHROME_BIN (or PUPPETEER_EXECUTABLE_PATH) must point at Chrome" );
		process.exit( 2 );
	}

	// Runs inside every frame before any page script; only the top frame reports.
	function pageTrap( skips, prefix ) {
		var realQUnit, hooked = false, skipMap = {}, k,
			nativeStringify = window.JSON && window.JSON.stringify,
			nativeLog = window.console && window.console.log,
			nativeConsole = window.console;

		if ( window.top !== window ) {
			return;
		}

		for ( k = 0; k < skips.length; k++ ) {
			skipMap[ skips[ k ] ] = true;
		}

		function emit( type, data ) {
			try {
				nativeLog.call( nativeConsole, prefix + nativeStringify.call( window.JSON || {}, {
					type: type,
					data: data
				}) );
			} catch ( e ) {
				try {
					nativeLog.call( nativeConsole, prefix + "{\"type\":\"emit-error\",\"data\":{}}" );
				} catch ( e2 ) {}
			}
		}

		function safeString( value ) {
			try {
				return String( value ).slice( 0, 500 );
			} catch ( e ) {
				return "<unprintable>";
			}
		}

		// De-register SEAL_SKIP_TESTS entries at declaration time. The globals cover
		// test/unit/*.js; QUnit.test covers asyncTest and the Sizzle subproject,
		// whose loader (test/data/testrunner.js) captures QUnit.test directly.
		function wrapDeclaration( owner, name ) {
			var original = owner[ name ];
			if ( typeof original !== "function" ) {
				return;
			}
			owner[ name ] = function( testName ) {
				var key = realQUnit.config.currentModule + ": " + testName;
				if ( skipMap.hasOwnProperty( key ) ) {
					emit( "skip", { name: key } );
					return;
				}
				return original.apply( this, arguments );
			};
		}

		// QUnit.load runs twice: from testinit.js's loader chain and as the window
		// "load" handler. Each run calls QUnit.init(), which rebuilds #qunit-tests.
		// If the window load event lands after testinit.js has called QUnit.start(),
		// the running test's result <li> is wiped and QUnit throws in its testDone
		// ("Cannot set properties of null"), wedging the suite. Hold that first
		// start() until the window load event has been dispatched.
		function guardStart( q ) {
			var originalStart = q.start;
			q.start = function() {
				var self = this,
					args = arguments;
				if ( document.readyState === "complete" ) {
					return originalStart.apply( self, args );
				}
				window.addEventListener( "load", function() {
					setTimeout(function() {
						originalStart.apply( self, args );
					}, 0 );
				});
			};
		}

		function registerCallbacks() {
			if ( hooked || !realQUnit || typeof realQUnit.log !== "function" || !realQUnit.config ) {
				return;
			}
			hooked = true;
			realQUnit.config.reorder = false;
			guardStart( realQUnit );
			realQUnit.moduleStart(function( d ) {
				emit( "moduleStart", { name: d.name } );
			});
			realQUnit.testStart(function( d ) {
				emit( "testStart", { module: d.module, name: d.name } );
			});
			realQUnit.log(function( d ) {
				if ( !d.result ) {
					emit( "assertFail", {
						module: d.module,
						name: d.name,
						message: safeString( d.message ),
						actual: safeString( d.actual ),
						expected: safeString( d.expected ),
						source: safeString( d.source )
					});
				}
			});
			realQUnit.testDone(function( d ) {
				emit( "testDone", {
					module: d.module,
					name: d.name,
					failed: d.failed,
					passed: d.passed,
					total: d.total
				});
			});
			realQUnit.done(function( d ) {
				emit( "done", {
					failed: d.failed,
					passed: d.passed,
					total: d.total,
					runtime: d.runtime
				});
			});
		}

		Object.defineProperty( window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				registerCallbacks();
				return realQUnit;
			},
			set: function( q ) {
				realQUnit = q;
				wrapDeclaration( window, "test" );
				wrapDeclaration( window, "asyncTest" );
				wrapDeclaration( q, "test" );
				registerCallbacks();
			}
		});

		window.addEventListener( "DOMContentLoaded", registerCallbacks );
	}

	function moduleEntry( name ) {
		if ( !modules.hasOwnProperty( name ) ) {
			modules[ name ] = { tests: 0, passed: 0, failed: 0, assertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function pad( value, width ) {
		var s = String( value );
		while ( s.length < width ) {
			s = " " + s;
		}
		return s;
	}

	function report( exitCode, reason ) {
		var j, name, m, unmatched = [], code = exitCode;

		if ( finished ) {
			return;
		}
		finished = true;
		clearTimeout( timer );

		console.log( "" );
		console.log( "Per-module results:" );
		console.log( "  module                 tests  passed  failed  assertions" );
		for ( j = 0; j < moduleOrder.length; j++ ) {
			name = moduleOrder[ j ];
			m = modules[ name ];
			console.log( "  " + ( name + "                       " ).slice( 0, 22 ) +
				pad( m.tests, 6 ) + pad( m.passed, 8 ) + pad( m.failed, 8 ) + pad( m.assertions, 12 ) );
		}

		if ( skipped.length ) {
			console.log( "" );
			console.log( "Skipped via SEAL_SKIP_TESTS (" + skipped.length + "):" );
			for ( j = 0; j < skipped.length; j++ ) {
				console.log( "  - " + skipped[ j ] );
			}
		}
		for ( j = 0; j < skipList.length; j++ ) {
			if ( skipped.indexOf( skipList[ j ] ) < 0 ) {
				unmatched.push( skipList[ j ] );
			}
		}
		if ( unmatched.length && reason === null ) {
			console.log( "" );
			console.log( "ERROR: SEAL_SKIP_TESTS entries matched no declared test:" );
			for ( j = 0; j < unmatched.length; j++ ) {
				console.log( "  - " + unmatched[ j ] );
			}
			code = code || 1;
		}

		if ( failures.length ) {
			console.log( "" );
			console.log( "Failed tests (" + failures.length + "):" );
			for ( j = 0; j < failures.length; j++ ) {
				console.log( "  - " + failures[ j ] );
			}
		}

		console.log( "" );
		if ( reason ) {
			console.log( "ERROR: " + reason );
		}
		console.log( "QUnit summary: " + state.tests + " tests, " + state.testsPassed + " passed, " +
			state.testsFailed + " failed, " + skipped.length + " skipped; assertions: " +
			( state.done ? state.done.total + " total, " + state.done.passed + " passed, " +
				state.done.failed + " failed" : "n/a" ) +
			( state.done ? "; runtime " + state.done.runtime + "ms" : "" ) );

		if ( !code && ( !state.done || state.tests === 0 ) ) {
			code = 1;
		}

		function exit() {
			process.exit( code );
		}
		if ( browser ) {
			browser.close().then( exit, exit );
		} else {
			exit();
		}
	}

	function handleEvent( type, data ) {
		var m, label;
		if ( type === "moduleStart" ) {
			console.log( "# module: " + data.name );
		} else if ( type === "testStart" ) {
			state.currentTest = data.module + ": " + data.name;
		} else if ( type === "skip" ) {
			skipped.push( data.name );
			console.log( "skip " + data.name );
		} else if ( type === "assertFail" ) {
			console.log( "  assertion failed in " + data.module + ": " + data.name );
			console.log( "    message:  " + data.message );
			console.log( "    expected: " + data.expected );
			console.log( "    actual:   " + data.actual );
			if ( data.source && data.source !== "undefined" ) {
				console.log( "    source:   " + data.source.split( "\n" )[ 0 ] );
			}
		} else if ( type === "testDone" ) {
			m = moduleEntry( data.module );
			label = data.module + ": " + data.name;
			m.tests++;
			m.assertions += data.total;
			state.tests++;
			if ( data.failed ) {
				m.failed++;
				state.testsFailed++;
				failures.push( label );
				console.log( "not ok " + state.tests + " " + label +
					" (" + data.failed + " failed, " + data.passed + " passed)" );
			} else {
				m.passed++;
				state.testsPassed++;
				console.log( "ok " + state.tests + " " + label + " (" + data.total + ")" );
			}
		} else if ( type === "done" ) {
			state.done = data;
			report( data.failed || state.testsFailed ? 1 : 0, null );
		} else if ( type === "emit-error" ) {
			console.log( "WARN: reporter could not serialise an event" );
		}
	}

	function onConsole( msg ) {
		var text = msg.text(), payload;
		if ( text.indexOf( emitPrefix ) !== 0 ) {
			return;
		}
		try {
			payload = JSON.parse( text.slice( emitPrefix.length ) );
		} catch ( e ) {
			console.log( "WARN: unparsable reporter event: " + text.slice( 0, 200 ) );
			return;
		}
		handleEvent( payload.type, payload.data );
	}

	function fail( reason ) {
		report( 2, reason );
	}

	timer = setTimeout(function() {
		fail( "timed out after " + timeoutMs + "ms" +
			( state.currentTest ? " (last test started: " + state.currentTest + ")" : "" ) );
	}, timeoutMs );

	console.log( "Running " + targetUrl + " in " + chromeBin );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.join( " ;; " ) );
	}

	puppeteer.launch({
		executablePath: chromeBin,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--window-size=1280,1024"
		]
	}).then(function( b ) {
		browser = b;
		return browser.newPage();
	}).then(function( page ) {
		page.on( "console", onConsole );
		page.on( "pageerror", function( err ) {
			console.log( "page error: " + ( err && err.message ? err.message : err ) );
		});
		page.on( "dialog", function( dialog ) {
			return dialog.dismiss();
		});
		return page.setViewport({ width: 1280, height: 1024 }).then(function() {
			return page.evaluateOnNewDocument( pageTrap, skipList, emitPrefix );
		}).then(function() {
			return page[ "goto" ]( targetUrl, { waitUntil: "load", timeout: 120000 } );
		});
	}).then( null, function( err ) {
		fail( "browser error: " + ( err && err.stack ? err.stack : err ) );
	});
})();
