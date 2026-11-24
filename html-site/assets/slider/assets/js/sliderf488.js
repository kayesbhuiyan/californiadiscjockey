/**
 * Simple Image Slider — Frontend Script
 * Pure JS, no dependencies, fully scoped to avoid global pollution.
 */
(function (root) {
    'use strict';

    // Namespace guard: prevent double-init if script is somehow loaded twice
    if (root.__sliderLoaded) return;
    root.__sliderLoaded = true;

    function initSlider(wrapper) {
        // Prevent double-initialisation on the same element
        if (wrapper.dataset.sliderInit === '1') return;
        wrapper.dataset.sliderInit = '1';

        var slider  = wrapper.querySelector('.slider');
        var slides  = wrapper.querySelectorAll('.slider > .slider-slide');
        var dots    = wrapper.querySelectorAll('.slider-dots > .slider-dot');
        var prevBtn = wrapper.querySelector('.slider-prev');
        var nextBtn = wrapper.querySelector('.slider-next');
        var total   = slides.length;

        if (total < 1) return;
        if (total < 2) {
            // Single slide: just show it, no controls needed
            slides[0].classList.add('slider-active');
            return;
        }

        var autoplay = wrapper.dataset.autoplay !== 'false';
        var speed    = parseInt(wrapper.dataset.speed, 10) || 4000;
        var current  = 0;
        var timer    = null;

        // Enable CSS fade transition
        wrapper.classList.add('slider-fade');

        /* ---- Core navigation ---- */
        function goTo(index) {
            var prev = current;
            current  = ((index % total) + total) % total;
            if (prev === current) return;

            slides[prev].classList.remove('slider-active');
            if (dots[prev]) dots[prev].classList.remove('slider-active');

            slides[current].classList.add('slider-active');
            if (dots[current]) dots[current].classList.add('slider-active');
        }

        function nextSlide() { goTo(current + 1); }
        function prevSlide() { goTo(current - 1); }

        /* ---- Autoplay ---- */
        function startTimer() {
            if (!autoplay) return;
            timer = setInterval(nextSlide, speed);
        }

        function stopTimer() {
            clearInterval(timer);
            timer = null;
        }

        function resetTimer() { stopTimer(); startTimer(); }

        /* ---- Arrow buttons ---- */
        if (prevBtn) {
            prevBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                prevSlide();
                resetTimer();
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                nextSlide();
                resetTimer();
            });
        }

        /* ---- Dot buttons ---- */
        for (var d = 0; d < dots.length; d++) {
            (function (index) {
                dots[index].addEventListener('click', function (e) {
                    e.stopPropagation();
                    goTo(index);
                    resetTimer();
                });
            })(d);
        }

        /* ---- Keyboard (when wrapper is focused) ---- */
        wrapper.setAttribute('tabindex', '0');
        wrapper.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowLeft'  || e.keyCode === 37) { prevSlide(); resetTimer(); }
            if (e.key === 'ArrowRight' || e.keyCode === 39) { nextSlide(); resetTimer(); }
        });

        /* ---- Touch / swipe ---- */
        var touchX = 0;
        wrapper.addEventListener('touchstart', function (e) {
            touchX = e.changedTouches[0].screenX;
        }, { passive: true });

        wrapper.addEventListener('touchend', function (e) {
            var diff = touchX - e.changedTouches[0].screenX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) { nextSlide(); } else { prevSlide(); }
                resetTimer();
            }
        }, { passive: true });

        /* ---- Pause on hover ---- */
        wrapper.addEventListener('mouseenter', stopTimer);
        wrapper.addEventListener('mouseleave', startTimer);

        /* ---- Start ---- */
        startTimer();
    }

    function initAll() {
        var wrappers = document.querySelectorAll('.slider-wrap');
        for (var i = 0; i < wrappers.length; i++) {
            initSlider(wrappers[i]);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

})(window);
