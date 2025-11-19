// Timezone-aware greeting function
function getGreeting() {
    const now = new Date();
    const hour = now.getHours();
    let greeting;

    // Determine greeting based on local time
    if (hour >= 5 && hour < 12) {
        greeting = "Good Morning";
    } else if (hour >= 12 && hour < 17) {
        greeting = "Good Afternoon";
    } else if (hour >= 17 && hour < 21) {
        greeting = "Good Evening";
    } else {
        greeting = "Good Night";
    }

    return greeting;
}

// Smooth text transition function
function updateGreetingWithTransition(element, newText) {
    element.style.opacity = '0';
    element.style.transform = 'translateY(20px)';
    
    setTimeout(() => {
        element.textContent = newText;
        element.style.opacity = '1';
        element.style.transform = 'translateY(0)';
    }, 300);
}

function configureLoginButton() {
    const loginButton = document.querySelector('.login-button');
    if (!loginButton) return;

    const fallbackUrl = loginButton.getAttribute('data-fallback-url') || loginButton.getAttribute('href') || '/';
    const remoteUrl = loginButton.getAttribute('data-remote-url');

    // Default to fallback to prevent a dead link while detection runs
    loginButton.setAttribute('href', fallbackUrl);

    if (!remoteUrl) {
        return;
    }

    fetch(remoteUrl, { mode: 'no-cors', cache: 'no-store' })
        .then(() => {
            loginButton.setAttribute('href', remoteUrl);
        })
        .catch(() => {
            loginButton.setAttribute('href', fallbackUrl);
        });
}

// Initialize particles.js and greeting on page load
document.addEventListener('DOMContentLoaded', function() {
    // Update greeting
    const greetingElement = document.getElementById('greeting');
    if (greetingElement) {
        greetingElement.textContent = getGreeting();
    }

    // Initialize particles.js
    if (typeof particlesJS !== 'undefined') {
        particlesJS("particles-js", {
            "particles": {
                "number": {
                    "value": 355,
                    "density": {
                        "enable": true,
                        "value_area": 789.15
                    }
                },
                "color": {
                    "value": "#ffffff"
                },
                "shape": {
                    "type": "circle",
                    "stroke": {
                        "width": 0,
                        "color": "#000000"
                    },
                    "polygon": {
                        "nb_sides": 5
                    },
                    "image": {
                        "src": "img/github.svg",
                        "width": 100,
                        "height": 100
                    }
                },
                "opacity": {
                    "value": 0.6,
                    "random": true,
                    "anim": {
                        "enable": true,
                        "speed": 0.3,
                        "opacity_min": 0.2,
                        "sync": false
                    }
                },
                "size": {
                    "value": 2,
                    "random": true,
                    "anim": {
                        "enable": true,
                        "speed": 0.333,
                        "size_min": 0,
                        "sync": false
                    }
                },
                "line_linked": {
                    "enable": false,
                    "distance": 150,
                    "color": "#ffffff",
                    "opacity": 0.4,
                    "width": 1
                },
                "move": {
                    "enable": true,
                    "speed": 0.8,
                    "direction": "none",
                    "random": true,
                    "straight": false,
                    "out_mode": "out",
                    "bounce": false,
                    "attract": {
                        "enable": false,
                        "rotateX": 600,
                        "rotateY": 1200
                    }
                }
            },
            "interactivity": {
                "detect_on": "canvas",
                "events": {
                    "onhover": {
                        "enable": true,
                        "mode": "bubble"
                    },
                    "onclick": {
                        "enable": true,
                        "mode": "push"
                    },
                    "resize": true
                },
                "modes": {
                    "grab": {
                        "distance": 400,
                        "line_linked": {
                            "opacity": 1
                        }
                    },
                    "bubble": {
                        "distance": 150,
                        "size": 4,
                        "duration": 2,
                        "opacity": 1,
                        "speed": 3
                    },
                    "repulse": {
                        "distance": 200,
                        "duration": 0.4
                    },
                    "push": {
                        "particles_nb": 4
                    },
                    "remove": {
                        "particles_nb": 2
                    }
                }
            },
            "retina_detect": true
        });
    }

    configureLoginButton();
});

// Update greeting every minute (in case user keeps page open)
setInterval(function() {
    const greetingElement = document.getElementById('greeting');
    if (greetingElement) {
        const newGreeting = getGreeting();
        if (greetingElement.textContent !== newGreeting) {
            updateGreetingWithTransition(greetingElement, newGreeting);
        }
    }
}, 60000);
