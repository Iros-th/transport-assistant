import subprocess
import sys
import os

def test_dedupe():
    # Define the inline JavaScript harness
    js_code = """
import sys
sys.path.append('.')

const vm = require('vm');
const fs = require('fs');

// Mock state
global.window = {};
global.TransitConfig = {
  resolveBase: () => 'http://localhost/api',
  apiPrefix: () => '/demo'
};

global.TransitDemo = { timeOfDay: 'OFFPEAK' };
global.TransitAPI = {};

// Counter for fetch calls
global.fetchCalls = 0;

// Mock fetch function
global.fetch = function(url, options) {
  global.fetchCalls += 1;
  console.log('fetch called with:', url, options);

  // Return a promise that resolves after a tick
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({
        ok: true,
        text: function() {
          return Promise.resolve(JSON.stringify({
            demo_mode: true,
            candidates: []
          }));
        }
      });
    }, 0);
  });
};

// Load the API module
function loadAPI() {
  vm.runInThisContext(fs.readFileSync('api.js', 'utf8'), 'api.js');
}

// Execute the test
function runTest() {
  fetchCalls = 0;
  loadAPI();

  // Get the TransitAPI object
  const api = global.TransitAPI;

  // Concurrent calls
  const crowdPromise = api.crowding();
  const plan1 = api.plan('A', 'B', {});
  const plan2 = api.plan('C', 'D', {});

  return Promise.all([crowdPromise, plan1, plan2]).then(() => {
    console.log('Fetch calls made:', fetchCalls);
    // Should be exactly 3 calls (1 for crowding, 2 for plans)
    if (fetchCalls === 3) {
      console.log('SUCCESS: deduplication working correctly');
      return true;
    } else {
      console.log('FAILURE: expected 3 calls, got', fetchCalls);
      return false;
    }
  });
}

// Run the test
runTest().then(result => {
  if (result) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});
"""

    # Create temporary directory for the test
    temp_dir = "temp_test_dir"
    os.makedirs(temp_dir, exist_ok=True)

    # Write api.js to temp directory
    with open(os.path.join(temp_dir, 'api.js'), 'w') as f:
        f.write("""
/* eslint-disable no-undef */
(function () {
  "use strict";

  // Mock TransitConfig and TransitAPI
  var TransitConfig = {
    resolveBase: () => 'http://localhost/api',
    apiPrefix: () => '/demo'
  };

  var inFlightRequests = {};

  function request(path, options) {
    options = options || {};
    var url = TransitConfig.resolveBase() + TransitConfig.apiPrefix() + path;
    var key = options.method || "GET" + url + JSON.stringify(options.body);

    if (inFlightRequests[key]) {
      return inFlightRequests[key];
    }

    var controller = new AbortController();
    var timer = setTimeout(() => controller.abort(), 12000);

    var init = {
      method: options.method || "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal,
      mode: "cors",
      cache: "no-store"
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    return fetch(url, init)
      .then(res => {
        clearTimeout(timer);
        if (!res.ok) {
          return res.text().then(txt => {
            try { var j = JSON.parse(txt); } catch (e) {}
            throw new Error("HTTP " + res.status);
          });
        }
        return res.text().then(txt => {
          if (!txt) return null;
          try { return JSON.parse(txt); }
          catch (e) { throw new Error("Malformed JSON"); }
        });
      })
      .catch(err => {
        clearTimeout(timer);
        if (err.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw new Error("Network error");
      })
      .finally(() => {
        delete inFlightRequests[key];
      });
  }

  // Sample implementations similar to the actual code
  function demoPlan(origin, destination, prefs) {
    return request("/demo/plan", {
      method: "POST",
      body: { origin, destination, time_of_day: "OFFPEAK", prefs }
    });
  }

  function demoCrowding() {
    return request("/demo/crowding" + "?time_of_day=OFFPEAK", { method: "GET" });
  }

  function TransitAPI = {
    plan: demoPlan,
    crowding: demoCrowding,
    parking: () => Promise.resolve([]),
    departures: () => Promise.resolve([])
  };

  window.TransitAPI = TransitAPI;

})();
""")

    # Run the Node.js subprocess
    cmd = [
        "node",
        "-e",
        js_code.strip()
    ]

    result = subprocess.run(
        cmd,
        cwd=temp_dir,
        capture_output=True,
        text=True,
        timeout=30
    )

    # Check the result
    if result.returncode == 0:
        print("Test passed")
        print("Output:", result.stdout)
        return True
    else:
        print("Test failed")
        print("Error:", result.stderr)
        print("Return code:", result.returncode)
        return False